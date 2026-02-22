CREATE TABLE IF NOT EXISTS telegram_flow_counters (
  counter_key TEXT PRIMARY KEY,
  counter_value BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
