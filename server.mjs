import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || '3000');
const serviceToken = String(process.env.REGPORTAL_BIZPORTAL_SERVICE_TOKEN || '').trim();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large.'));
      }
    });

    request.on('end', () => {
      try {
        resolve(body === '' ? {} : JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });

    request.on('error', reject);
  });
}

function authorized(request) {
  if (serviceToken === '') {
    return true;
  }

  const header = String(request.headers['x-regportal-service-token'] || '').trim();
  return header !== '' && header === serviceToken;
}

function runWorker(enterpriseNumber) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'worker.mjs');
    const child = spawn(process.execPath, [workerPath, '--enterprise-number', enterpriseNumber], {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Worker exited with code ${code}.`).trim()));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('Worker returned invalid JSON output.'));
      }
    });
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== 'POST' || request.url !== '/check') {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (!authorized(request)) {
    sendJson(response, 401, { error: 'Invalid service token.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const enterpriseNumber = String(body.enterprise_number || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (enterpriseNumber === '') {
      sendJson(response, 400, { error: 'enterprise_number is required.' });
      return;
    }

    const result = await runWorker(enterpriseNumber);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, () => {
  process.stdout.write(`BizPortal service listening on port ${port}\n`);
});