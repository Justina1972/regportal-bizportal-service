import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

function installChromium() {
  const cliPath = path.resolve(process.cwd(), 'node_modules', 'playwright', 'cli.js');

  if (!fs.existsSync(cliPath)) {
    throw new Error(`Playwright CLI not found at ${cliPath}`);
  }

  const install = spawnSync(process.execPath, [cliPath, 'install', 'chromium'], {
    stdio: 'inherit',
    env: process.env,
  });

  if (install.status !== 0) {
    throw new Error(`Playwright browser install failed with exit code ${install.status ?? 'unknown'}`);
  }
}

function ensureChromiumPresent() {
  const executablePath = chromium.executablePath();
  if (executablePath && fs.existsSync(executablePath)) {
    console.log(`Playwright Chromium already present: ${executablePath}`);
    return;
  }

  console.log('Playwright Chromium missing. Installing now...');
  installChromium();
}

ensureChromiumPresent();
