CREATE TABLE IF NOT EXISTS telegram_reports (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  update_id BIGINT NOT NULL,
  analyzer_model TEXT NOT NULL,
  reporter_model TEXT NOT NULL,
  user_text TEXT NOT NULL,
  analysis TEXT NOT NULL,
  reply TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_reports_chat_created_at
  ON telegram_reports (chat_id, created_at DESC, id DESC);