ALTER TABLE telegram_reports
  ADD COLUMN IF NOT EXISTS queue_wait_ms INTEGER,
  ADD COLUMN IF NOT EXISTS input_resolution_ms INTEGER,
  ADD COLUMN IF NOT EXISTS analyzer_duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS reporter_duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS telegram_send_duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS total_duration_ms INTEGER;
