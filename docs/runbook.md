# Bot Coach Runbook

## Health Checks

- API health: `GET /health`
- Queue health (admin): `GET /admin/queue/health`
- Failed jobs (admin): `GET /admin/queue/failed?limit=20`
- DLQ jobs (admin): `GET /admin/queue/dlq?limit=20`

All admin endpoints require header:

`x-admin-key: <ADMIN_API_KEY>`

## DLQ Recovery

1. List DLQ jobs from `/admin/queue/dlq`.
2. Pick a `jobId`.
3. Requeue it with:

`POST /admin/queue/dlq/requeue/:jobId`

If the job fails again, investigate logs before another requeue attempt.

## Logs

- API logs:
  - webhook ingress and route status
- Worker logs:
  - `Job started`, `Job succeeded`, `Job failed`
  - retry logs for OpenRouter and Telegram
  - `Worker metrics snapshot` every 60 seconds

## Incident Notes

- If `/health` is `degraded`, check database and redis connectivity first.
- If DLQ grows, inspect `errorMessage` from DLQ payload and recent worker logs.
- If retries spike, suspect upstream instability (OpenRouter or Telegram API).
