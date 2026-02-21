DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_profiles_coach_mode_check'
  ) THEN
    ALTER TABLE user_profiles DROP CONSTRAINT user_profiles_coach_mode_check;
  END IF;
END $$;

ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_coach_mode_check
  CHECK (
    coach_mode IN (
      'reality_check',
      'cbt_patterns',
      'self_sabotage',
      'behavioral_activation',
      'anxiety_grounding',
      'decision_clarity',
      'post_failure_reset'
    )
  );