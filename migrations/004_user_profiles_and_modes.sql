CREATE TABLE IF NOT EXISTS user_profiles (
  user_id BIGINT PRIMARY KEY,
  coach_mode TEXT NOT NULL DEFAULT 'reality_check' CHECK (coach_mode IN ('reality_check', 'cbt_patterns')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE telegram_reports
  ADD COLUMN IF NOT EXISTS coach_mode TEXT NOT NULL DEFAULT 'reality_check';