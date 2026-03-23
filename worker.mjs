import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function envFlag(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function envNumber(name, defaultValue) {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value >= 0 ? value : defaultValue;
}

function normalizeEnterpriseNumber(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function debugEnabled() {
  return envFlag('REGPORTAL_BIZPORTAL_DEBUG', false);
}

function debugLog(...parts) {
  if (!debugEnabled()) {
    return;
  }

  const line = `[bizportal-debug] ${parts.join(' ')}`;
  process.stderr.write(`${line}\n`);

  const logPath = path.resolve(process.cwd(), 'bizportal-trace.log');
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (String(value || '').trim() !== '') {
      return String(value).trim();
    }
  }

  return '';
}

function resolveBrowserPath() {
  const explicit = firstNonEmpty(process.env.REGPORTAL_BIZPORTAL_BROWSER_PATH);
  if (explicit !== '') {
    return explicit;
  }

  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

function isNavigationContextError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /execution context was destroyed|most likely because of a navigation|cannot find context with specified id|frame was detached|navigation interrupted/i.test(message);
}

async function waitForPageStability(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 });
      await page.locator('body').first().waitFor({ state: 'attached', timeout: 2000 });
      try {
        await page.waitForLoadState('networkidle', { timeout: 3000 });
      } catch {
        await page.waitForTimeout(500);
      }
      return;
    } catch (error) {
      if (!isNavigationContextError(error)) {
        break;
      }
      await page.waitForTimeout(500);
    }
  }

  await page.waitForTimeout(1000);
}

async function safePageEvaluate(page, evaluator, arg, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await page.evaluate(evaluator, arg);
    } catch (error) {
      if (!isNavigationContextError(error) || attempt === retries - 1) {
        throw error;
      }
      await waitForPageStability(page, 6000);
    }
  }

  return null;
}

async function safeFrameEvaluate(frame, evaluator, arg, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await frame.evaluate(evaluator, arg);
    } catch (error) {
      if (!isNavigationContextError(error) || attempt === retries - 1) {
        throw error;
      }

      try {
        await waitForPageStability(frame.page(), 6000);
      } catch {
        // Ignore wait failures and retry frame evaluation.
      }
    }
  }

  return null;
}

async function clickFirstVisible(page, selectors, options = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() === 0) {
      continue;
    }
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    await locator.click(options);
    return true;
  }

  return false;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() === 0) {
      continue;
    }
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    await locator.fill(value);
    return true;
  }

  return false;
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() === 0) {
      continue;
    }
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    return locator;
  }

  return null;
}

async function firstVisibleLocatorInFrames(page, selectors) {
  const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];

  for (const frame of frames) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      if (await locator.count() === 0) {
        continue;
      }
      if (!(await locator.isVisible().catch(() => false))) {
        continue;
      }

      return locator;
    }
  }

  return null;
}

async function typeInto(locator, value, visibleTyping) {
  await locator.click();
  await locator.fill('');

  if (visibleTyping) {
    await locator.pressSequentially(value, { delay: 75 });
    return;
  }

  await locator.fill(value);
}

async function forceValueIfEmpty(locator, value) {
  const current = await locator.inputValue().catch(() => '');
  if (String(current || '').trim() !== '') {
    return;
  }

  await locator.evaluate((node, nextValue) => {
    const input = node;
    input.focus();
    input.value = String(nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function setLoginMode(page, loginMode) {
  const checkbox = page.locator('#cntMain_chkId');
  if (await checkbox.count() === 0) {
    debugLog('login_mode_checkbox=missing');
    return;
  }

  const shouldUseId = loginMode !== 'customer_code';
  let isChecked = null;
  try {
    isChecked = await checkbox.isChecked({ timeout: 2000 });
  } catch {
    debugLog('login_mode_checkbox=isChecked_timeout');
  }

  if (isChecked === null) {
    return;
  }

  if (isChecked === shouldUseId) {
    debugLog('login_mode_checkbox=already_correct');
    return;
  }

  try {
    await checkbox.click({ timeout: 2000, force: true });
    await page.waitForTimeout(500);
    debugLog('login_mode_checkbox=toggled');
  } catch {
    debugLog('login_mode_checkbox=click_timeout');
  }
}

async function resolveUsernameLocator(page, loginMode) {
  const customerCodeSelectors = [
    '#cntMain_txtCustomerCode',
    'input[name*="CustomerCode"]',
    'input[id*="CustomerCode"]',
    'input[name*="customer"]'
  ];
  const idSelectors = [
    '#cntMain_txtIDNo',
    'input[name*="txtIDNo"]',
    'input[placeholder*="ID Number"]'
  ];

  const expectedSelectors = loginMode === 'customer_code' ? customerCodeSelectors : idSelectors;
  const fallbackSelectors = loginMode === 'customer_code' ? idSelectors : customerCodeSelectors;

  const expected = await firstVisibleLocatorInFrames(page, expectedSelectors);
  if (expected) {
    return expected;
  }

  const fallback = await firstVisibleLocatorInFrames(page, fallbackSelectors);
  if (fallback) {
    return fallback;
  }

  return firstVisibleLocatorInFrames(page, [
    'input[type="text"]:not([name*="search" i]):not([id*="search" i])',
    'input[type="email"]'
  ]);
}

async function resolvePasswordLocator(page) {
  return firstVisibleLocatorInFrames(page, [
    '#cntMain_txtPassword',
    'input[type="password"]',
    'input[name*="Password" i]',
    'input[id*="Password" i]'
  ]);
}

async function resolveLoginButtonLocator(page) {
  return firstVisibleLocatorInFrames(page, [
    '#cntMain_btnLogin',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'input[type="submit"][value*="Log" i]',
    'input[type="button"][value*="Log" i]',
    'button[type="submit"]'
  ]);
}

async function readLoginFailureDetails(page) {
  const details = await safePageEvaluate(page, () => {
    const selectors = [
      '.validation-summary-errors',
      '.validation-summary-valid',
      '.field-validation-error',
      '.text-danger',
      '.alert',
      '.alert-danger',
      '.error',
      '.message',
      '#lblError',
      '#cntMain_lblError',
      'span[id*="Error"]',
      'div[id*="Error"]'
    ];

    const messages = [];
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text !== '' && !messages.includes(text)) {
          messages.push(text);
        }
      }
    }

    const bodySnippet = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    return {
      messages,
      bodySnippet,
      title: (document.title || '').trim(),
    };
  });

  return details;
}

async function login(page, username, password, loginMode) {
  const visibleTyping = !envFlag('REGPORTAL_BIZPORTAL_HEADLESS', true);

  debugLog('step=goto_login_start');
  await page.goto('https://www.bizportal.gov.za/login.aspx', { waitUntil: 'domcontentloaded' });
  debugLog('step=goto_login_done', 'url=', page.url());
  await page.waitForTimeout(1000);

  debugLog('step=set_login_mode_start');
  await setLoginMode(page, loginMode);
  debugLog('step=set_login_mode_done');

  debugLog('url=', page.url(), 'frames=', String(page.frames().length), 'loginMode=', loginMode);

  const usernameLocator = await resolveUsernameLocator(page, loginMode);
  if (!usernameLocator) {
    throw new Error('Unable to find the BizPortal username input field.');
  }

  const passwordLocator = await resolvePasswordLocator(page);
  if (!passwordLocator) {
    throw new Error('Unable to find the BizPortal password input field.');
  }

  const loginButtonLocator = await resolveLoginButtonLocator(page);
  if (!loginButtonLocator) {
    throw new Error('Unable to find the BizPortal login button.');
  }

  await typeInto(usernameLocator, username, visibleTyping);
  await forceValueIfEmpty(usernameLocator, username);

  await typeInto(passwordLocator, password, visibleTyping);
  await forceValueIfEmpty(passwordLocator, password);

  const usernameAfter = await usernameLocator.inputValue().catch(() => '');
  const passwordAfter = await passwordLocator.inputValue().catch(() => '');
  debugLog('usernameLength=', String(usernameAfter.length), 'passwordLength=', String(passwordAfter.length));

  if (visibleTyping) {
    await page.waitForTimeout(800);
  }

  await loginButtonLocator.click();
  debugLog('step=login_clicked');
  await page.waitForTimeout(3000);
  debugLog('step=post_login_wait_done', 'url=', page.url());

  if (page.url().toLowerCase().includes('login.aspx')) {
    const details = await readLoginFailureDetails(page);
    const bodyText = details.bodySnippet || await page.locator('body').innerText();
    debugLog('still_on_login_page=true');
    if (details.messages.length > 0) {
      debugLog('login_failure_messages=', details.messages.join(' || '));
    }
    if (/password required|invalid|login|id number|customer code|incorrect|unsuccessful/i.test(bodyText)) {
      const reason = details.messages[0] || bodyText.replace(/\s+/g, ' ').trim().slice(0, 220);
      throw new Error(`BizPortal login failed: ${reason}`);
    }

    const fallbackReason = details.messages[0] || bodyText.replace(/\s+/g, ' ').trim().slice(0, 220);
    throw new Error(`BizPortal remained on login page after submit. Page said: ${fallbackReason}`);
  }
}

async function navigateToEntitySearch(page) {
  debugLog('step=navigate_entity_search_start', 'url=', page.url());

  const isBizProfilePage = async () => {
    try {
      return await safePageEvaluate(page, () => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return /bizprofile is a search tool for all cipc registered entities/i.test(text)
          || /type in your search query/i.test(text)
          || /select search option/i.test(text)
          || /enterprise number/i.test(text);
      });
    } catch {
      return false;
    }
  };

  const openBizProfilePage = async () => {
    const bizProfileLink = await firstVisibleLocatorInFrames(page, [
      'a[href*="bizprofile.aspx"]',
      'a:has-text("BizProfile")',
      'input[value*="PROFILE" i]',
      'input[value*="BIZPROFILE" i]'
    ]);

    if (bizProfileLink) {
      try {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
          bizProfileLink.click({ force: true, timeout: 4000 })
        ]);
      } catch {
        try {
          await bizProfileLink.evaluate((node) => node.click());
        } catch {
          // Ignore and fall back to direct navigation.
        }
      }
    }

    await waitForPageStability(page, 10000);

    if (!(await isBizProfilePage())) {
      try {
        await page.goto('https://www.bizportal.gov.za/bizprofile.aspx', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        // Ignore direct navigation failures; subsequent checks will surface them.
      }
    }

    await waitForPageStability(page, 10000);
  };

  // First try clicking the search/magnifying-glass icon in the nav
  const openedSearch = await clickFirstVisible(page, [
    'a[href*="bizprofile.aspx"]',
    'a[href*="search"]',
    'a:has(i.fa-search)',
    'a:has-text("Entity Search")'
  ]);

  if (openedSearch) {
    debugLog('step=clicked_search_nav_icon');
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      await page.waitForTimeout(2000);
    }
    debugLog('step=after_search_nav_wait', 'url=', page.url());
  }

  // Then look for the Entity Search menu item/tab
  const openedEntitySearch = await clickFirstVisible(page, [
    'a:has-text("Entity Search")',
    'button:has-text("Entity Search")',
    'li:has-text("Entity Search") a',
    'span:has-text("Entity Search")'
  ]);

  if (openedEntitySearch) {
    debugLog('step=clicked_entity_search_tab');
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      await page.waitForTimeout(2000);
    }
    debugLog('step=after_entity_search_wait', 'url=', page.url());
  }

  if (await page.locator('a[href*="bizprofile.aspx" i], a:has-text("BizProfile")').count().catch(() => 0)) {
    debugLog('step=home_page_contains_bizprofile_link');
    await openBizProfilePage();
    debugLog('step=after_explicit_bizprofile_open', 'url=', page.url());
  }

  // If we still don't see a search input, try navigating directly to known search URLs
  const hasSearchInput = await page.locator('input[type="text"]').count();
  if (!openedSearch && !openedEntitySearch && hasSearchInput === 0) {
    debugLog('step=fallback_direct_nav');
    try {
      await page.goto('https://www.bizportal.gov.za/bizprofile.aspx', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(1500);
      debugLog('step=direct_nav_done', 'url=', page.url());
    } catch (err) {
      debugLog('step=direct_nav_failed', String(err.message));
    }
  }

  if (!(await isBizProfilePage())) {
    debugLog('step=force_bizprofile_page');
    await openBizProfilePage();
  }

  debugLog('step=navigate_entity_search_done', 'url=', page.url());
}

async function setSearchMode(page) {
  const result = await safePageEvaluate(page, () => {
    // --- Try dropdown select ---
    const selects = Array.from(document.querySelectorAll('select'));
    const allOptions = [];
    for (const select of selects) {
      for (const opt of Array.from(select.options)) {
        allOptions.push(`select#${select.id}[name=${select.name}] option[value=${opt.value}]: "${opt.textContent.trim()}"`);
      }
      // Match enterprise number/name OR registration number
      const option = Array.from(select.options).find((candidate) => {
        const t = (candidate.textContent || candidate.value || '').trim().toLowerCase();
        return /enterprise\s*(no|num|number)|registration\s*(no|num|number)|reg\s*no/i.test(t);
      });
      if (option) {
        if (select.value === option.value) {
          return { status: 'already_set', allOptions };
        }
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { status: 'changed', allOptions };
      }
    }

    // --- Try radio buttons ---
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const allRadios = radios.map((r) => `radio#${r.id}[name=${r.name}][value=${r.value}] label="${(document.querySelector('label[for="' + r.id + '"]') || {}).textContent || ''}"`);
    for (const radio of radios) {
      const label = document.querySelector(`label[for="${radio.id}"]`);
      const labelText = (label ? label.textContent : radio.value || '').trim().toLowerCase();
      if (/enterprise\s*(no|num|number)|registration\s*(no|num|number)|reg\s*no/i.test(labelText)) {
        if (!radio.checked) {
          radio.click();
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          return { status: 'radio_clicked', allOptions, allRadios };
        }
        return { status: 'radio_already_set', allOptions, allRadios };
      }
    }

    // --- Try clickable text controls / custom widgets ---
    const clickableCandidates = Array.from(document.querySelectorAll('label, button, a, span, div, li'));
    for (const candidate of clickableCandidates) {
      const text = (candidate.textContent || '').trim().toLowerCase();
      if (!/enterprise\s*(no|num|number)|registration\s*(no|num|number)|reg\s*no/i.test(text)) {
        continue;
      }

      const rect = candidate.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      if (typeof candidate.click === 'function') {
        candidate.click();
      } else {
        candidate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }

      return { status: 'clicked_text_control', allOptions, allRadios, pageSnippet: text.slice(0, 120) };
    }

    // Dump all text on page for diagnosis when nothing found
    const pageSnippet = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400);
    return { status: 'not_found', allOptions, allRadios, pageSnippet };
  });

  debugLog('setSearchMode=', result.status);
  if (result.allOptions && result.allOptions.length) {
    debugLog('select_options=', result.allOptions.join(' || '));
  } else {
    debugLog('select_options=NONE');
  }
  if (result.allRadios && result.allRadios.length) {
    debugLog('radio_buttons=', result.allRadios.join(' || '));
  } else {
    debugLog('radio_buttons=NONE');
  }
  if (result.status === 'not_found' && result.pageSnippet) {
    debugLog('page_text_snippet=', result.pageSnippet);
  }

  if (result.status === 'changed' || result.status === 'radio_clicked' || result.status === 'clicked_text_control') {
    // ASP.NET AutoPostBack triggers a page reload; wait for it to settle
    await waitForPageStability(page, 7000);
  }
}

async function searchEnterprise(page, enterpriseNumber) {
  debugLog('step=search_mode_start');
  await setSearchMode(page);
  debugLog('step=search_mode_done');

  debugLog('step=fill_enterprise_start');
  // Re-fill after the Enterprise No selection postback settles.
  await page.waitForTimeout(1200);

  const searchInputSelectors = [
    '#cntMain_txtEnterpriseNo',
    '#cntMain_txtSearch',
    'input[placeholder*="Type in search query" i]',
    'input[placeholder*="Enterprise" i]',
    'input[name*="Enterprise" i]',
    'input[id*="Enterprise" i]',
    'input[placeholder*="Registration" i]',
    'input[name*="Search" i]:not([type="submit"])',
    'input[id*="Search" i]:not([type="submit"])',
    'input[type="text"]'
  ];

  const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];
  let filled = false;
  let filledSelector = '';
  let filledLocator = null;

  for (const frame of frames) {
    for (const selector of searchInputSelectors) {
      const locator = frame.locator(selector).first();
      if (await locator.count().catch(() => 0) === 0) continue;
      if (!(await locator.isVisible().catch(() => false))) continue;

      try {
        await locator.click({ timeout: 2000 });
      } catch { /* ignore */ }

      try {
        await locator.fill('');
        await locator.fill(enterpriseNumber);
      } catch {
        try {
          await locator.evaluate((el, value) => {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, enterpriseNumber);
        } catch { /* ignore */ }
      }

      await page.waitForTimeout(250);
      const val = await locator.inputValue().catch(() => '');
      debugLog('search_input=', selector, 'value_length=', String(val.length));
      if (val.trim() === enterpriseNumber) {
        filled = true;
        filledSelector = selector;
        filledLocator = locator;
        break;
      }
    }

    if (filled) {
      break;
    }
  }

  if (!filled) {
    throw new Error('Unable to find or fill the BizPortal enterprise search input field.');
  }

  // Verify the value still exists immediately before pressing SEARCH.
  let valuePersisted = false;
  for (const frame of frames) {
    if (valuePersisted) break;
    const locator = frame.locator(filledSelector).first();
    if (await locator.count().catch(() => 0) === 0) continue;

    let currentValue = await locator.inputValue().catch(() => '');
    if (currentValue.trim() !== enterpriseNumber) {
      try {
        await locator.evaluate((el, value) => {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, enterpriseNumber);
        currentValue = await locator.inputValue().catch(() => '');
      } catch { /* ignore */ }
    }

    valuePersisted = currentValue.trim() === enterpriseNumber;
    debugLog('search_input_verified=', filledSelector, 'ok=', String(valuePersisted));
  }

  if (!valuePersisted) {
    throw new Error('BizPortal cleared the enterprise number before search could run.');
  }

  debugLog('step=fill_enterprise_done');

  debugLog('step=click_search_start');
  const searchBtnLocator = await firstVisibleLocatorInFrames(page, [
    '#cntMain_btnSearch',
    '#cntMain_btnFind',
    '#cntMain_btnGo',
    'input[type="submit"][value*="Search" i]',
    'input[type="submit"][value*="Find" i]',
    'button[type="submit"]',
    'button:has-text("Search")',
    'button:has-text("Find")',
    'input[type="button"][value*="Search" i]',
    'a:has-text("Search")'
  ]);

  if (!searchBtnLocator) {
    // Last resort: dump all visible buttons/submits for debugging
    const btns = await safePageEvaluate(page, () => {
      return Array.from(document.querySelectorAll('input[type=submit],input[type=button],button'))
        .filter((el) => el.offsetParent !== null)
        .map((el) => `${el.tagName}#${el.id}[value=${el.value}][text=${el.textContent.trim().slice(0,30)}]`);
    });
    debugLog('visible_buttons=', btns.join(' | '));
    throw new Error('Unable to find the BizPortal search button.');
  }

  try {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      searchBtnLocator.click()
    ]);
  } catch {
    await searchBtnLocator.click({ force: true });
  }
  debugLog('step=click_search_done');

  await waitForPageStability(page, 15000);

  let bodyAfterSearch = await safePageEvaluate(page, () => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500)).catch(() => '');
  if (!new RegExp(enterpriseNumber, 'i').test(bodyAfterSearch) && /type in your search query|select search option|bizprofile is a search tool/i.test(bodyAfterSearch)) {
    debugLog('step=search_retry_enter_key');
    if (filledLocator) {
      try {
        await filledLocator.press('Enter');
      } catch {
        try {
          await filledLocator.evaluate((el) => {
            const form = el.closest('form');
            if (form) {
              form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              if (typeof form.submit === 'function') {
                form.submit();
              }
            }
          });
        } catch {
          // Ignore retry failure; later diagnostics will surface page state.
        }
      }
      await waitForPageStability(page, 12000);
      bodyAfterSearch = await safePageEvaluate(page, () => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500)).catch(() => '');
    }
  }

  debugLog('step=search_results_loaded', 'url=', page.url());
}

async function openResult(page, enterpriseNumber) {
  debugLog('step=open_result_start', 'url=', page.url());

  // Save a screenshot so we can see the results page
  if (debugEnabled()) {
    try {
      await page.screenshot({ path: path.resolve(process.cwd(), 'bizportal-results.png'), fullPage: false });
      debugLog('screenshot=bizportal-results.png');
    } catch { /* ignore */ }
  }

  // Helper: get all frames including nested iframes
  const getAllFrames = () => [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  const collectResultPageDiagnostics = async () => {
    const diagnostics = [];

    for (const frame of getAllFrames()) {
      try {
        const info = await safeFrameEvaluate(frame, (enterpriseNumberArg) => {
          const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
          const clickables = Array.from(document.querySelectorAll('a, button, input, img, td, div[role="button"], span[role="button"]'))
            .map((el) => {
              const text = (el.textContent || el.value || el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
              const href = (el.getAttribute('href') || '').trim();
              const onclick = (el.getAttribute('onclick') || '').replace(/\s+/g, ' ').trim();
              return { tag: el.tagName, text, href, onclick };
            })
            .filter((item) => item.text || item.href || item.onclick)
            .filter((item) => /view|details|profile|select|__dopostback|registered/i.test(`${item.text} ${item.href} ${item.onclick}`))
            .slice(0, 12);

          return {
            url: location.href,
            title: document.title,
            containsEnterprise: bodyText.includes(enterpriseNumberArg),
            snippet: bodyText.slice(0, 350),
            clickables,
          };
        }, enterpriseNumber);
        diagnostics.push(info);
      } catch {
        // Ignore inaccessible frames.
      }
    }

    return diagnostics;
  };
  const resultWaitMs = envNumber('REGPORTAL_BIZPORTAL_RESULTS_WAIT_MS', 35000);
  debugLog('result_wait_ms=', String(resultWaitMs));

  // If we already landed on the detail page, skip result clicking.
  for (const frame of getAllFrames()) {
    const alreadyOnDetail = await safeFrameEvaluate(frame, () => {
      const text = (document.body?.textContent || '').replace(/\s+/g, ' ');
      return /auditor\s*&\s*annual\s*return\s*details/i.test(text);
    }).catch(() => false);
    if (alreadyOnDetail) {
      debugLog('step=open_result_already_on_detail');
      return;
    }
  }

  // Step 1: Poll for the result row to appear in any frame.
  // BizPortal uses ASP.NET UpdatePanels, so the result list can render late.
  let resultFrame = null;
  const waitDeadline = Date.now() + resultWaitMs;
  while (Date.now() < waitDeadline) {
    for (const frame of getAllFrames()) {
      try {
        const hasIt = await safeFrameEvaluate(frame, (enterpriseNumberArg) => {
          const text = document.body ? document.body.textContent || '' : '';
          return text.includes(enterpriseNumberArg) || /registered/i.test(text);
        }, enterpriseNumber);
        if (hasIt) { resultFrame = frame; break; }
      } catch { /* frame might not be ready */ }
    }
    if (resultFrame) break;
    await page.waitForTimeout(600);
  }
  debugLog('result_frame_found=', resultFrame ? resultFrame.url().slice(-50) : 'none');

  // Step 2: Dump all clickable elements from ALL frames for diagnosis
  if (debugEnabled()) {
    for (let fi = 0; fi < getAllFrames().length; fi++) {
      const frame = getAllFrames()[fi];
      try {
        const dump = await safeFrameEvaluate(frame, () => {
          return Array.from(document.querySelectorAll('a, button, input[type=image], input[type=submit], img, td'))
            .map((el) => {
              const text = (el.textContent || el.value || el.alt || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 40);
              const oc = (el.getAttribute('onclick') || '').slice(0, 80);
              const vis = el.offsetParent !== null;
              return `${el.tagName}#${el.id || el.name || '?'}[vis=${vis}][text=${text}][onclick=${oc}]`;
            })
            .join(' || ');
        });
        debugLog(`frame${fi}(${frame.url().slice(-40)}) clickables=`, dump || '(none)');
      } catch { /* ignore */ }
    }
  }

  // Step 3: JS click inside the frame — target the row for this enterprise number,
  // then click the View image/cell or its nearest clickable ancestor.
  let clicked = false;
  const framesToTry = resultFrame
    ? [resultFrame, ...getAllFrames().filter((f) => f !== resultFrame)]
    : getAllFrames();

  for (const frame of framesToTry) {
    if (clicked) break;
    try {
      const result = await safeFrameEvaluate(frame, (enterpriseNumberArg) => {
        const clickTarget = (target) => {
          if (!target) return null;
          const clickableAncestor = target.closest('a, button, td, tr');
          const chosen = clickableAncestor || target;

          if (typeof chosen.click === 'function') {
            chosen.click();
          } else {
            chosen.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }

          return `clicked:${chosen.tagName}#${chosen.id || chosen.getAttribute('name') || '?'}`;
        };

        const rows = Array.from(document.querySelectorAll('tr, [role="row"], .rgRow, .rgAltRow, .grid-row'));
        const matchingRows = rows.filter((row) => {
          const text = (row.textContent || '').replace(/\s+/g, ' ').toUpperCase();
          const hasEnterprise = text.includes(enterpriseNumberArg);
          const hasRegistered = /REGISTERED/i.test(text);
          const hasCells = row.querySelectorAll('td').length >= 2;
          return hasCells && (hasEnterprise || hasRegistered);
        });

        for (const row of matchingRows) {
          const cells = Array.from(row.querySelectorAll('td'));

          // If WebForms attached onclick handlers, prefer firing them directly.
          const rowOnClick = row.getAttribute('onclick') || '';
          if (rowOnClick) {
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
            return `clicked:TR#${row.id || '?'}[onclick]`;
          }

          const imageTarget = row.querySelector('td img, a img, img[onclick], img[style], img[src]');
          if (imageTarget) {
            const resultText = clickTarget(imageTarget);
            if (resultText) return resultText;
          }

          const explicitViewTarget = row.querySelector([
            'a[title*="View" i]',
            'a[aria-label*="View" i]',
            'a[href*="View" i]',
            'a[href*="__doPostBack" i]',
            'a[onclick*="__doPostBack" i]',
            'button[title*="View" i]',
            'input[value*="View" i]',
            'input[title*="View" i]',
            '[onclick*="View" i]',
            '[onclick*="Details" i]'
          ].join(','));
          if (explicitViewTarget) {
            const resultText = clickTarget(explicitViewTarget);
            if (resultText) return resultText;
          }

          const lastCell = cells[cells.length - 1];
          const viewCell = cells.find((cell) => /view/i.test(cell.textContent || '')) || lastCell;
          const control = viewCell
            ? viewCell.querySelector('a, button, input[type=image], input[type=submit], img') || viewCell
            : null;
          const resultText = clickTarget(control);
          if (resultText) return resultText;

          // Final row fallback: click the row itself.
          const rowResult = clickTarget(row);
          if (rowResult) return rowResult;
        }

        return null;
      }, enterpriseNumber);
      if (result) {
        debugLog('step=view_clicked via JS', result);
        clicked = true;
      }
    } catch { /* ignore */ }
  }

  // Step 4: Playwright click fallback on the last cell / image in the matched row.
  if (!clicked) {
    debugLog('step=open_result_playwright_fallback');
    for (const frame of framesToTry) {
      if (clicked) break;
      let rows = frame.locator('tr').filter({ hasText: new RegExp(`${enterpriseNumber}.*registered|registered.*${enterpriseNumber}`, 'i') });
      let rowCount = await rows.count().catch(() => 0);
      if (rowCount === 0) {
        rows = frame.locator('tr').filter({ hasText: /registered/i });
        rowCount = await rows.count().catch(() => 0);
      }
      for (let i = 0; i < rowCount && !clicked; i++) {
        const links = rows.nth(i).locator('td img, a, button, input[type="image"], input[type="submit"], img');
        const lc = await links.count().catch(() => 0);
        for (let j = lc - 1; j >= 0; j--) {
          try {
            await links.nth(j).click({ force: true, timeout: 3000 });
            debugLog('step=view_clicked via playwright force', String(j));
            clicked = true;
            break;
          } catch { /* try next */ }
        }

        if (!clicked) {
          try {
            await rows.nth(i).click({ force: true, timeout: 3000 });
            debugLog('step=view_clicked via row_click', String(i));
            clicked = true;
            break;
          } catch { /* try next */ }
        }

        if (!clicked) {
          try {
            await rows.nth(i).dblclick({ force: true, timeout: 3000 });
            debugLog('step=view_clicked via row_dblclick', String(i));
            clicked = true;
            break;
          } catch { /* try next */ }
        }
      }
    }
  }

  // Step 5: Slow rescue pass.
  // Some runs need additional time after the initial postback to bind row click handlers.
  if (!clicked) {
    debugLog('step=open_result_slow_rescue_wait');
    await page.waitForTimeout(8000);

    for (const frame of framesToTry) {
      if (clicked) break;

      const rows = frame.locator('tr').filter({ hasText: new RegExp(`${enterpriseNumber}`, 'i') });
      let rowCount = await rows.count().catch(() => 0);
      let rowsToUse = rows;
      if (rowCount === 0) {
        rowsToUse = frame.locator('tr').filter({ hasText: /registered|active/i });
        rowCount = await rowsToUse.count().catch(() => 0);
      }
      debugLog('slow_rescue_rows=', String(rowCount));

      for (let i = 0; i < rowCount && !clicked; i++) {
        try {
          const row = rowsToUse.nth(i);
          const cells = row.locator('td');
          const cellCount = await cells.count().catch(() => 0);

          if (cellCount > 0) {
            await cells.nth(cellCount - 1).click({ force: true, timeout: 3000 });
            debugLog('step=view_clicked via slow_rescue_last_cell', String(i));
            clicked = true;
            break;
          }
        } catch { /* try next */ }

        if (!clicked) {
          try {
            await rowsToUse.nth(i).click({ force: true, timeout: 3000 });
            debugLog('step=view_clicked via slow_rescue_row_click', String(i));
            clicked = true;
            break;
          } catch { /* try next */ }
        }

        if (!clicked) {
          try {
            await rowsToUse.nth(i).dblclick({ force: true, timeout: 3000 });
            debugLog('step=view_clicked via slow_rescue_row_dblclick', String(i));
            clicked = true;
            break;
          } catch { /* try next */ }
        }
      }
    }
  }

  if (!clicked) {
    // Last fallback: continue when annual-return details are already in DOM/text.
    const hasAnnualDataAlready = await Promise.all(getAllFrames().map((frame) => safeFrameEvaluate(frame, () => {
      const text = (document.body?.textContent || '').replace(/\s+/g, ' ');
      return /Outstanding Annual Returns?|AR\s+Year|AR\s+Non-Compliance\s+Date|Auditor\s*&\s*Annual\s*Return\s*Details/i.test(text);
    }).catch(() => false))).then((flags) => flags.some(Boolean));

    if (hasAnnualDataAlready) {
      debugLog('step=open_result_skipped_click_using_existing_annual_data');
      return;
    }

    const diagnostics = await collectResultPageDiagnostics();
    const summary = diagnostics.map((item, index) => {
      const clickables = item.clickables.map((entry) => `${entry.tag}:${entry.text || entry.href || entry.onclick}`).join(' | ');
      return `frame${index + 1} title=${item.title} containsEnterprise=${item.containsEnterprise} snippet=${item.snippet} clickables=${clickables}`;
    }).join(' || ');

    throw new Error(`Unable to find the BizPortal View action for the search result. ${summary}`);
  }

  debugLog('step=view_clicked');

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    await page.waitForTimeout(3000);
  }

  if (debugEnabled()) {
    try {
      await page.screenshot({ path: path.resolve(process.cwd(), 'bizportal-detail.png'), fullPage: false });
      debugLog('screenshot=bizportal-detail.png');
    } catch { /* ignore */ }
  }

  debugLog('step=open_result_done', 'url=', page.url());
}

async function expandAnnualReturnSection(page) {
  debugLog('step=expand_annual_return_section_start');

  const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];
  let expanded = false;
  const headerPattern = /auditor\s*&\s*annual\s*return\s*details/i;

  const sectionIsOpen = async (frame) => {
    try {
      return await safeFrameEvaluate(frame, () => {
        const text = (document.body?.textContent || '').replace(/\u00a0/g, ' ');
        return /Outstanding Annual Returns?/i.test(text) || /AR\s+Non-Compliance\s+Date/i.test(text);
      });
    } catch {
      return false;
    }
  };

  const forceRevealSection = async (frame) => {
    try {
      return await safeFrameEvaluate(frame, () => {
        const headerPattern = /auditor\s*&\s*annual\s*return\s*details/i;
        const headers = Array.from(document.querySelectorAll('div,button,a,li,span,h1,h2,h3,h4,h5'));
        const header = headers.find((el) => headerPattern.test((el.textContent || '').replace(/\s+/g, ' ')));
        if (!header) {
          return false;
        }

        const containers = [
          header.closest('li'),
          header.closest('section'),
          header.closest('article'),
          header.closest('div[class*="panel" i]'),
          header.closest('div[class*="card" i]'),
          header.closest('div[class*="collapsible" i]'),
          header.parentElement,
          header.parentElement?.parentElement
        ].filter(Boolean);

        let revealed = false;
        for (const container of containers) {
          if (!container) continue;

          container.classList.add('active', 'open', 'show');
          if (container.style) {
            container.style.display = 'block';
            container.style.maxHeight = 'none';
            container.style.height = 'auto';
            container.style.visibility = 'visible';
            container.style.opacity = '1';
          }

          const descendants = Array.from(container.querySelectorAll('*'));
          for (const el of descendants) {
            if (!(el instanceof HTMLElement)) continue;
            const t = (el.textContent || '').replace(/\s+/g, ' ');
            if (/Outstanding Annual Returns?|AR\s+Non-Compliance\s+Date/i.test(t)) {
              el.classList.add('active', 'open', 'show');
              el.style.display = 'block';
              el.style.maxHeight = 'none';
              el.style.height = 'auto';
              el.style.visibility = 'visible';
              el.style.opacity = '1';
              revealed = true;
            }
          }
        }

        return revealed;
      });
    } catch {
      return false;
    }
  };

  for (const frame of frames) {
    if (await sectionIsOpen(frame)) {
      expanded = true;
      break;
    }

    const candidates = frame.locator('div,button,a,li,span,h1,h2,h3,h4,h5').filter({ hasText: headerPattern });
    const count = await candidates.count().catch(() => 0);

    for (let index = 0; index < count; index++) {
      const candidate = candidates.nth(index);
      try {
        await candidate.scrollIntoViewIfNeeded().catch(() => {});
      } catch { /* ignore */ }

      // 1) Direct click on header text container
      try {
        await candidate.click({ force: true, timeout: 2500 });
        await page.waitForTimeout(700);
        if (await sectionIsOpen(frame)) {
          expanded = true;
          debugLog('annual_return_section_clicked=header', 'index=', String(index));
          break;
        }
      } catch { /* try next strategy */ }

      // 2) Click icon/arrow child inside the header row
      try {
        const icon = candidate.locator('i,svg,img,span').last();
        if (await icon.count().catch(() => 0) > 0) {
          await icon.click({ force: true, timeout: 2500 });
          await page.waitForTimeout(700);
          if (await sectionIsOpen(frame)) {
            expanded = true;
            debugLog('annual_return_section_clicked=icon', 'index=', String(index));
            break;
          }
        }
      } catch { /* try next strategy */ }

      // 3) Click near the right edge of the header (where the arrow sits)
      try {
        const box = await candidate.boundingBox();
        if (box) {
          await page.mouse.click(box.x + Math.max(8, box.width - 12), box.y + (box.height / 2));
          await page.waitForTimeout(700);
          if (await sectionIsOpen(frame)) {
            expanded = true;
            debugLog('annual_return_section_clicked=right_edge', 'index=', String(index));
            break;
          }
        }
      } catch { /* try next strategy */ }

      // 4) Dispatch raw mouse events from inside the frame for custom handlers
      try {
        const clicked = await candidate.evaluate((el) => {
          const target = el.closest('.collapsible-header, .accordion-header, .panel-heading, .card-header, [role="button"], button, a, li, div, section, article') || el;
          target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }).catch(() => false);

        if (clicked) {
          await page.waitForTimeout(800);
          if (await sectionIsOpen(frame)) {
            expanded = true;
            debugLog('annual_return_section_clicked=synthetic_events', 'index=', String(index));
            break;
          }
        }
      } catch { /* ignore */ }
    }

    if (expanded) {
      break;
    }
  }

  if (!expanded) {
    for (const frame of frames) {
      const forced = await forceRevealSection(frame);
      if (forced) {
        await page.waitForTimeout(700);
      }
      if (forced && await sectionIsOpen(frame)) {
        expanded = true;
        debugLog('annual_return_section_clicked=force_reveal');
        break;
      }
    }
  }

  debugLog('annual_return_section_click_sent=', String(expanded));

  if (expanded) {
    const expandDeadline = Date.now() + 5000;
    while (Date.now() < expandDeadline) {
      let visible = false;
      for (const frame of frames) {
        if (await sectionIsOpen(frame)) {
          visible = true;
          break;
        }
      }
      if (visible) {
        debugLog('annual_return_section_content_visible=true');
        break;
      }
      await page.waitForTimeout(400);
    }
  }

  await page.waitForTimeout(1500);

  if (debugEnabled()) {
    try {
      await page.screenshot({ path: path.resolve(process.cwd(), 'bizportal-annual-return-section.png'), fullPage: false });
      debugLog('screenshot=bizportal-annual-return-section.png');
    } catch { /* ignore */ }
  }
}

async function extractOutstandingAnnualReturns(page) {
  await expandAnnualReturnSection(page);

  const frames = [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())];
  let bestSnippet = '';

  for (const frame of frames) {
    try {
      const extracted = await safeFrameEvaluate(frame, () => {
        const text = (document.body.textContent || '').replace(/\u00a0/g, ' ');

        // Generic table scan fallback for pages where section visibility/state is unreliable.
        const tables = Array.from(document.querySelectorAll('table'));
        for (const table of tables) {
          const headerText = Array.from(table.querySelectorAll('th')).map((th) => th.textContent.trim()).join(' | ');
          if (!/AR\s*Year/i.test(headerText) || !/AR\s*Month|Month/i.test(headerText) || !/Non-Compliance|Date Filed|Date/i.test(headerText)) {
            continue;
          }

          const rows = Array.from(table.querySelectorAll('tr')).slice(1);
          const entries = rows
            .map((row) => Array.from(row.querySelectorAll('td')).map((td) => td.textContent.trim()))
            .filter((cells) => cells.length >= 3 && cells[0] && cells[1] && cells[2]);

          if (entries.length > 0) {
            const normalized = entries.map((cells) => `${cells[0]} ${cells[1]} ${cells[2]}`);
            return {
              outstandingAnnualReturns: normalized.join('; '),
              rawSnippet: normalized.join(' | ')
            };
          }
        }

        // Prefer structured extraction from the OUTSTANDING ANNUAL RETURNS table
        const headingCandidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,strong,b,div,span,a'));
        const outstandingHeading = headingCandidates.find((el) => /Outstanding Annual Returns?/i.test((el.textContent || '').replace(/\s+/g, ' ')));
        if (outstandingHeading) {
          let container = outstandingHeading.closest('section,article,div,li') || outstandingHeading.parentElement;
          let table = null;
          for (let i = 0; i < 4 && container && !table; i += 1) {
            table = container.querySelector('table');
            container = container.parentElement;
          }

          if (table) {
            const rows = Array.from(table.querySelectorAll('tr')).slice(1);
            const entries = rows
              .map((row) => Array.from(row.querySelectorAll('td')).map((td) => td.textContent.trim()))
              .filter((cells) => cells.length >= 3 && cells[0] && cells[1] && cells[2]);

            if (entries.length > 0) {
              const normalized = entries.map((cells) => `${cells[0]} ${cells[1]} ${cells[2]}`);
              return {
                outstandingAnnualReturns: normalized.join('; '),
                rawSnippet: normalized.join(' | ')
              };
            }
          }
        }

        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!/Outstanding Annual Returns?/i.test(line)) {
            continue;
          }

          const inlineMatch = line.match(/Outstanding Annual Returns?\s*:?\s*(.+)$/i);
          if (inlineMatch && inlineMatch[1] && !/Outstanding Annual Returns?/i.test(inlineMatch[1])) {
            return {
              outstandingAnnualReturns: inlineMatch[1].trim(),
              rawSnippet: lines.slice(Math.max(0, index - 2), index + 3).join(' | ')
            };
          }

          const nextLine = lines[index + 1] || '';
          return {
            outstandingAnnualReturns: nextLine.trim(),
            rawSnippet: lines.slice(Math.max(0, index - 2), index + 3).join(' | ')
          };
        }

        return {
          outstandingAnnualReturns: '',
          rawSnippet: text.replace(/\s+/g, ' ').slice(0, 500)
        };
      });

      if (extracted.outstandingAnnualReturns) {
        return extracted;
      }

      if (!bestSnippet && extracted.rawSnippet && /Outstanding Annual Returns?|AR\s*Year|AR\s*Month/i.test(extracted.rawSnippet)) {
        bestSnippet = extracted.rawSnippet;
      }
    } catch { /* ignore */ }
  }

  if (bestSnippet) {
    return {
      outstandingAnnualReturns: '',
      rawSnippet: bestSnippet
    };
  }

  return {
    outstandingAnnualReturns: '',
    rawSnippet: ''
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const enterpriseNumber = normalizeEnterpriseNumber(args['enterprise-number']);
  const username = firstNonEmpty(process.env.REGPORTAL_BIZPORTAL_USERNAME);
  const password = firstNonEmpty(process.env.REGPORTAL_BIZPORTAL_PASSWORD);
  const loginMode = firstNonEmpty(process.env.REGPORTAL_BIZPORTAL_LOGIN_MODE, 'id_number').toLowerCase();
  const timeoutMs = Number(process.env.REGPORTAL_BIZPORTAL_TIMEOUT_MS || '45000');
  const slowMoMs = envNumber('REGPORTAL_BIZPORTAL_SLOWMO_MS', 0);
  const keepOpenOnError = envFlag('REGPORTAL_BIZPORTAL_KEEP_OPEN_ON_ERROR', false);
  const keepOpenMs = envNumber(
    'REGPORTAL_BIZPORTAL_KEEP_OPEN_MS',
    debugEnabled() ? 15000 : 0,
  );

  debugLog('worker_start', 'cwd=', process.cwd());

  if (enterpriseNumber === '') {
    throw new Error('Missing --enterprise-number argument.');
  }
  if (username === '' || password === '') {
    throw new Error('BizPortal credentials are not configured in the environment.');
  }

  const browserPath = resolveBrowserPath();
  const launchOptions = {
    headless: envFlag('REGPORTAL_BIZPORTAL_HEADLESS', true),
    slowMo: slowMoMs,
    channel: 'chromium',
  };

  if (browserPath !== '') {
    launchOptions.executablePath = browserPath;
    delete launchOptions.channel;
  }

  const browser = await chromium.launch(launchOptions);

  let shouldPauseBeforeClose = false;

  try {
    const page = await browser.newPage();
    debugLog('step=new_page_done');
    page.setDefaultTimeout(timeoutMs);

    await login(page, username, password, loginMode);
    await navigateToEntitySearch(page);
    await searchEnterprise(page, enterpriseNumber);
    await openResult(page, enterpriseNumber);
    const extracted = await extractOutstandingAnnualReturns(page);
    debugLog('extracted_outstanding_annual_returns=', JSON.stringify(extracted));
    shouldPauseBeforeClose = keepOpenMs > 0;

    process.stdout.write(JSON.stringify({
      enterpriseNumber,
      outstandingAnnualReturns: extracted.outstandingAnnualReturns,
      rawSnippet: extracted.rawSnippet,
      checkedAt: new Date().toISOString(),
      currentUrl: page.url(),
    }));
  } catch (error) {
    if (keepOpenOnError) {
      shouldPauseBeforeClose = true;
    }
    throw error;
  } finally {
    if (shouldPauseBeforeClose && keepOpenMs > 0) {
      debugLog('pause_before_close_ms=', String(keepOpenMs));
      await new Promise((resolve) => setTimeout(resolve, keepOpenMs));
    }
    await browser.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message);
  process.exit(1);
});