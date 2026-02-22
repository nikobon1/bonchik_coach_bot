CREATE TABLE IF NOT EXISTS telegram_daily_summaries (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  summary_date DATE NOT NULL,
  timezone TEXT NOT NULL,
  reports_count INTEGER NOT NULL,
  window_start_at TIMESTAMPTZ NOT NULL,
  window_end_at TIMESTAMPTZ NOT NULL,
  summary_text TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_daily_summaries_chat_date
  ON telegram_daily_summaries (chat_id, summary_date);

CREATE INDEX IF NOT EXISTS idx_telegram_daily_summaries_sent_at
  ON telegram_daily_summaries (sent_at DESC, id DESC);
