# BizPortal Remote Service

This folder can run as a small Node service for shared-hosted RegPortal installs where PHP cannot execute Node locally.

## What this does

- Exposes `POST /check` to run the existing BizPortal Playwright worker.
- Exposes `GET /health` for uptime checks.
- Lets the PHP portal call a remote endpoint with `REGPORTAL_BIZPORTAL_ENDPOINT`.

## Environment variables

- `REGPORTAL_BIZPORTAL_USERNAME`: BizPortal login username.
- `REGPORTAL_BIZPORTAL_PASSWORD`: BizPortal login password.
- `REGPORTAL_BIZPORTAL_LOGIN_MODE`: usually `id_number` or `customer_code`.
- `REGPORTAL_BIZPORTAL_SERVICE_TOKEN`: shared secret used by the PHP portal.
- `REGPORTAL_BIZPORTAL_BROWSER_PATH`: optional explicit browser path.
- `PORT`: HTTP port for the service.

## Local run

```bash
npm install
npx playwright install chromium
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

Check request:

```bash
curl -X POST http://localhost:3000/check \
  -H "Content-Type: application/json" \
  -H "X-RegPortal-Service-Token: your-token" \
  -d '{"enterprise_number":"200001234507"}'
```

## PHP portal configuration

Set these on the PHP host:

- `REGPORTAL_BIZPORTAL_ENDPOINT=https://your-runner.example.com/check`
- `REGPORTAL_BIZPORTAL_SERVICE_TOKEN=your-token`

With those values set, the PHP portal will call the remote service instead of trying to execute `node` on shared hosting.