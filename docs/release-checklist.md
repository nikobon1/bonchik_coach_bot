# Release Checklist

## 1. Pre-release

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- Confirm migrations are committed.
- Confirm `.env.example` includes all required variables.

## 2. Deploy

- Push to `main`.
- Redeploy Railway services:
  - `railway redeploy --service web`
  - `railway redeploy --service worker`

## 3. Post-deploy Smoke

- Run health check:
  - `npm run smoke` with `SMOKE_BASE_URL` set.
- Run admin smoke check:
  - Set `SMOKE_ADMIN_API_KEY` and rerun `npm run smoke`.
- Optionally set `SMOKE_CHAT_ID` to verify reports endpoint.

Example:

```powershell
$env:SMOKE_BASE_URL = "https://web-production-a9ae6.up.railway.app"
$env:SMOKE_ADMIN_API_KEY = "<ADMIN_API_KEY>"
$env:SMOKE_CHAT_ID = "216536651"
npm run smoke
```

## 4. Runtime Verification

- `GET /health` returns `ok`.
- Worker logs show startup and no crash loops.
- Queue health endpoint responds with `ok: true`.
- DLQ is not growing unexpectedly.

## 5. Rollback Plan

- Redeploy previous stable commit in Railway.
- If schema change introduced issue, apply compensating migration.
- Keep webhook active and monitor retry/DLQ behavior after rollback.