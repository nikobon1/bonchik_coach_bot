import { Pool } from 'pg';

export type CoachMode = 'reality_check' | 'cbt_patterns';

export type UserProfile = {
  userId: number;
  coachMode: CoachMode;
  createdAt: string;
  updatedAt: string;
};

type UserProfileRow = {
  user_id: number;
  coach_mode: CoachMode;
  created_at: string;
  updated_at: string;
};

const mapProfile = (row: UserProfileRow): UserProfile => ({
  userId: row.user_id,
  coachMode: row.coach_mode,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const getOrCreateUserProfile = async (pool: Pool, userId: number): Promise<UserProfile> => {
  await pool.query(
    `
      INSERT INTO user_profiles (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  const result = await pool.query(
    `
      SELECT user_id, coach_mode, created_at, updated_at
      FROM user_profiles
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  return mapProfile(result.rows[0] as UserProfileRow);
};

export const setUserCoachMode = async (pool: Pool, userId: number, coachMode: CoachMode): Promise<UserProfile> => {
  const result = await pool.query(
    `
      INSERT INTO user_profiles (user_id, coach_mode)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET coach_mode = EXCLUDED.coach_mode, updated_at = NOW()
      RETURNING user_id, coach_mode, created_at, updated_at
    `,
    [userId, coachMode]
  );

  return mapProfile(result.rows[0] as UserProfileRow);
};