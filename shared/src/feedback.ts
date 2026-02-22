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

export const TELEGRAM_FLOW_COUNTER_KEYS = [
  'feedback_started',
  'feedback_saved',
  'feedback_cancelled',
  'mode_recommendation_started',
  'mode_recommendation_suggested',
  'mode_recommendation_cancelled'
] as const;

export type TelegramFlowCounterKey = (typeof TELEGRAM_FLOW_COUNTER_KEYS)[number];

export type TelegramFlowCounterView = {
  key: TelegramFlowCounterKey;
  value: number;
  updatedAt: string;
};

export type TelegramFlowEventRecord = {
  key: TelegramFlowCounterKey;
  chatId: number;
  userId: number;
  updateId: number;
};

export type TelegramFlowDailyCounterView = {
  date: string;
  key: TelegramFlowCounterKey;
  value: number;
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

type TelegramFlowCounterRow = {
  counter_key: TelegramFlowCounterKey;
  counter_value: string;
  updated_at: string;
};

type TelegramFlowDailyCounterRow = {
  event_date: string;
  counter_key: TelegramFlowCounterKey;
  event_count: string;
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

export const incrementTelegramFlowCounter = async (
  pool: Pool,
  counterKey: TelegramFlowCounterKey
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO telegram_flow_counters (counter_key, counter_value)
      VALUES ($1, 1)
      ON CONFLICT (counter_key)
      DO UPDATE SET counter_value = telegram_flow_counters.counter_value + 1, updated_at = NOW()
    `,
    [counterKey]
  );
};

export const appendTelegramFlowEvent = async (pool: Pool, event: TelegramFlowEventRecord): Promise<void> => {
  await pool.query(
    `
      INSERT INTO telegram_flow_events (
        counter_key,
        chat_id,
        user_id,
        update_id
      ) VALUES ($1, $2, $3, $4)
    `,
    [event.key, event.chatId, event.userId, event.updateId]
  );
};

export const listTelegramFlowCounters = async (pool: Pool): Promise<TelegramFlowCounterView[]> => {
  const result = await pool.query(
    `
      SELECT counter_key, counter_value, updated_at
      FROM telegram_flow_counters
      ORDER BY counter_key ASC
    `
  );

  return (result.rows as TelegramFlowCounterRow[]).map((row) => ({
    key: row.counter_key,
    value: Number(row.counter_value),
    updatedAt: row.updated_at
  }));
};

export const listTelegramFlowDailyCounters = async (
  pool: Pool,
  days = 14
): Promise<TelegramFlowDailyCounterView[]> => {
  const result = await pool.query(
    `
      SELECT
        ((created_at AT TIME ZONE 'UTC')::date)::text AS event_date,
        counter_key,
        COUNT(*)::bigint AS event_count
      FROM telegram_flow_events
      WHERE created_at >=
        (date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        - (($1::int - 1) * INTERVAL '1 day')
      GROUP BY ((created_at AT TIME ZONE 'UTC')::date), counter_key
      ORDER BY event_date ASC, counter_key ASC
    `,
    [days]
  );

  return (result.rows as TelegramFlowDailyCounterRow[]).map((row) => ({
    date: row.event_date,
    key: row.counter_key,
    value: Number(row.event_count)
  }));
};
