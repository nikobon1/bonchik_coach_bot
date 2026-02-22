CREATE TABLE IF NOT EXISTS telegram_flow_events (
  id BIGSERIAL PRIMARY KEY,
  counter_key TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  update_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_flow_events_created_at
  ON telegram_flow_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_flow_events_key_created_at
  ON telegram_flow_events (counter_key, created_at DESC, id DESC);
