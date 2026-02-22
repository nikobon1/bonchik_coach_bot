CREATE TABLE IF NOT EXISTS telegram_feedback (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT,
  update_id BIGINT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_feedback_chat_created
  ON telegram_feedback (chat_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS user_feedback_state (
  user_id BIGINT PRIMARY KEY,
  awaiting_feedback BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
