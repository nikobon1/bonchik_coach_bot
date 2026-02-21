# Bot Coach Runbook

## Required Variables

- `APP_URL=https://<web-domain>.up.railway.app`
- `ADMIN_API_KEY=<strong random secret>`
- `TELEGRAM_WEBHOOK_SECRET=<strong random secret>`
- `DATABASE_URL` must reference Railway Postgres `DATABASE_URL`
- `REDIS_URL` must reference Railway Redis `REDIS_URL`

## Runtime Checks

- Public health: `GET /health`
- Queue health (admin): `GET /admin/queue/health`
- Main queue failed jobs (admin): `GET /admin/queue/failed?limit=20`
- DLQ jobs (admin): `GET /admin/queue/dlq?limit=20`
- Reports by chat (admin): `GET /admin/reports/:chatId?limit=20`

All admin endpoints require header:

`x-admin-key: <ADMIN_API_KEY>`

## User Mode Commands

- Set strict reality-check style:
`/mode reality_check`
- Set CBT-pattern-focused style:
`/mode cbt_patterns`
- Set anti-sabotage style:
`/mode self_sabotage`
- Set activation style:
`/mode behavioral_activation`
- Set anxiety-grounding style:
`/mode anxiety_grounding`
- Set decision mode:
`/mode decision_clarity`
- Set post-failure reset mode:
`/mode post_failure_reset`
- Show current + available modes:
`/mode` or `/mode help`
- Show one-line descriptions for all modes:
`/mode info` or button `ℹ️ Режимы — кратко`

## Quick Commands (PowerShell)

```powershell
$base = "https://<web-domain>.up.railway.app"
$admin = "<ADMIN_API_KEY>"

(Invoke-WebRequest "$base/health").Content
Invoke-RestMethod "$base/admin/queue/health" -Headers @{ "x-admin-key" = $admin }
Invoke-RestMethod "$base/admin/queue/failed?limit=20" -Headers @{ "x-admin-key" = $admin }
Invoke-RestMethod "$base/admin/queue/dlq?limit=20" -Headers @{ "x-admin-key" = $admin }
Invoke-RestMethod "$base/admin/reports/216536651?limit=20" -Headers @{ "x-admin-key" = $admin }
```

## Ops Script

Use `scripts/ops.ps1` for routine checks:

```powershell
./scripts/ops.ps1 -Action health -BaseUrl $base
./scripts/ops.ps1 -Action queue-health -BaseUrl $base -AdminApiKey $admin
./scripts/ops.ps1 -Action dlq -BaseUrl $base -AdminApiKey $admin -Limit 20
./scripts/ops.ps1 -Action reports -BaseUrl $base -AdminApiKey $admin -ChatId 216536651 -Limit 20
./scripts/ops.ps1 -Action requeue -BaseUrl $base -AdminApiKey $admin -JobId "<jobId>"
```

## Smoke Script

Use `scripts/smoke.mjs` for automated post-deploy checks:

```powershell
$env:SMOKE_BASE_URL = $base
$env:SMOKE_ADMIN_API_KEY = $admin
$env:SMOKE_CHAT_ID = "216536651"
npm run smoke
```

## DLQ Recovery Procedure

1. Confirm app health is `ok`.
2. Inspect worker logs for failure reason:
`railway logs --service worker --lines 200`
3. List DLQ jobs and choose one `jobId`.
4. Requeue one job:

```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "$base/admin/queue/dlq/requeue/<jobId>" `
  -Headers @{ "x-admin-key" = $admin }
```

5. Watch worker logs for the reprocessed job outcome.
6. If the job fails again, stop requeueing and fix root cause first.

## Alert Thresholds

- `/health` returns `degraded` for more than 2 minutes.
- Worker logs show repeated `Job failed` entries.
- DLQ waiting count grows steadily for 10+ minutes.
- `openRouterRetries` or `telegramRetries` spikes suddenly.

## Incident Triage

1. Check `web` logs:
`railway logs --service web --lines 200`
2. Check `worker` logs:
`railway logs --service worker --lines 200`
3. Check queue state:
`GET /admin/queue/health`
4. If DB/Redis auth or DNS errors appear, verify service variable references in Railway.
5. Redeploy after config fix:
`railway redeploy --service web` and `railway redeploy --service worker`
