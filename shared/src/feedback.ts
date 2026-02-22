import { Pool } from 'pg';

export type TelegramFeedbackRecord = {
  chatId: number;
  userId: number;
  username?: string;
  updateId: number;
  message: string;
};

export type TelegramFeedbackView = {
  id: number;
  chatId: number;
  userId: number;
  username?: string;
  updateId: number;
  message: string;
  createdAt: string;
};

type TelegramFeedbackRow = {
  id: number;
  chat_id: number;
  user_id: number;
  username: string | null;
  update_id: number;
  message: string;
  created_at: string;
};

type FeedbackStateRow = {
  awaiting_feedback: boolean;
  awaiting_mode_recommendation: boolean;
};

export const appendTelegramFeedback = async (pool: Pool, feedback: TelegramFeedbackRecord): Promise<void> => {
  await pool.query(
    `
      INSERT INTO telegram_feedback (
        chat_id,
        user_id,
        username,
        update_id,
        message
      ) VALUES ($1, $2, $3, $4, $5)
    `,
    [feedback.chatId, feedback.userId, feedback.username ?? null, feedback.updateId, feedback.message]
  );
};

export const listTelegramFeedbackByChat = async (
  pool: Pool,
  chatId: number,
  limit = 20
): Promise<TelegramFeedbackView[]> => {
  const result = await pool.query(
    `
      SELECT
        id,
        chat_id,
        user_id,
        username,
        update_id,
        message,
        created_at
      FROM telegram_feedback
      WHERE chat_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [chatId, limit]
  );

  return (result.rows as TelegramFeedbackRow[]).map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    username: row.username ?? undefined,
    updateId: row.update_id,
    message: row.message,
    createdAt: row.created_at
  }));
};

export const setAwaitingFeedbackState = async (
  pool: Pool,
  userId: number,
  awaitingFeedback: boolean
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO user_feedback_state (user_id, awaiting_feedback)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET awaiting_feedback = EXCLUDED.awaiting_feedback, updated_at = NOW()
    `,
    [userId, awaitingFeedback]
  );
};

export const isAwaitingFeedbackState = async (pool: Pool, userId: number): Promise<boolean> => {
  const result = await pool.query(
    `
      SELECT awaiting_feedback
      FROM user_feedback_state
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  if ((result.rowCount ?? 0) === 0) {
    return false;
  }

  return (result.rows[0] as FeedbackStateRow).awaiting_feedback;
};

export const setAwaitingModeRecommendationState = async (
  pool: Pool,
  userId: number,
  awaitingModeRecommendation: boolean
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO user_feedback_state (user_id, awaiting_mode_recommendation)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET awaiting_mode_recommendation = EXCLUDED.awaiting_mode_recommendation, updated_at = NOW()
    `,
    [userId, awaitingModeRecommendation]
  );
};

export const isAwaitingModeRecommendationState = async (pool: Pool, userId: number): Promise<boolean> => {
  const result = await pool.query(
    `
      SELECT awaiting_mode_recommendation
      FROM user_feedback_state
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  if ((result.rowCount ?? 0) === 0) {
    return false;
  }

  return (result.rows[0] as FeedbackStateRow).awaiting_mode_recommendation;
};
