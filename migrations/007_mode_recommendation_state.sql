ALTER TABLE user_feedback_state
ADD COLUMN IF NOT EXISTS awaiting_mode_recommendation BOOLEAN NOT NULL DEFAULT FALSE;
