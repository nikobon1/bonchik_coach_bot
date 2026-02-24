import { Pool } from 'pg';
import type { CoachMode } from './profiles';

export type TelegramReportRecord = {
  chatId: number;
  userId: number;
  updateId: number;
  coachMode: CoachMode;
  analyzerModel: string;
  reporterModel: string;
  userText: string;
  analysis: string;
  reply: string;
  queueWaitMs?: number | null;
  inputResolutionMs?: number | null;
  analyzerDurationMs?: number | null;
  reporterDurationMs?: number | null;
  telegramSendDurationMs?: number | null;
  totalDurationMs?: number | null;
};

export type TelegramReportView = {
  id: number;
  chatId: number;
  userId: number;
  updateId: number;
  coachMode: CoachMode;
  analyzerModel: string;
  reporterModel: string;
  userText: string;
  analysis: string;
  reply: string;
  queueWaitMs?: number | null;
  inputResolutionMs?: number | null;
  analyzerDurationMs?: number | null;
  reporterDurationMs?: number | null;
  telegramSendDurationMs?: number | null;
  totalDurationMs?: number | null;
  createdAt: string;
};

export type TelegramReportChatRef = {
  chatId: number;
  userId: number;
};

export type TelegramDailySummaryRecord = {
  chatId: number;
  userId: number;
  summaryDate: string;
  timezone: string;
  reportsCount: number;
  windowStartAt: string;
  windowEndAt: string;
  summaryText: string;
};

export type TelegramMorningSummaryStatus = {
  totalSent: number;
  sentLast24h: number;
  sentTodayUtc: number;
  distinctChatsLast7d: number;
  lastSentAt?: string;
  lastSummaryDate?: string;
  lastTimezone?: string;
  lastChatId?: number;
  lastUserId?: number;
  lastReportsCount?: number;
};

type TelegramReportRow = {
  id: number;
  chat_id: number;
  user_id: number;
  update_id: number;
  coach_mode: CoachMode;
  analyzer_model: string;
  reporter_model: string;
  user_text: string;
  analysis: string;
  reply: string;
  queue_wait_ms: number | null;
  input_resolution_ms: number | null;
  analyzer_duration_ms: number | null;
  reporter_duration_ms: number | null;
  telegram_send_duration_ms: number | null;
  total_duration_ms: number | null;
  created_at: string;
};

type TelegramReportChatRefRow = {
  chat_id: number;
  user_id: number;
};

type TelegramMorningSummaryStatusRow = {
  total_sent: number;
  sent_last_24h: number;
  sent_today_utc: number;
  distinct_chats_last_7d: number;
  last_sent_at: string | null;
  last_summary_date: string | null;
  last_timezone: string | null;
  last_chat_id: number | null;
  last_user_id: number | null;
  last_reports_count: number | null;
};

export const appendTelegramReport = async (pool: Pool, report: TelegramReportRecord): Promise<void> => {
  await pool.query(
    `
      INSERT INTO telegram_reports (
        chat_id,
        user_id,
        update_id,
        coach_mode,
        analyzer_model,
        reporter_model,
        user_text,
        analysis,
        reply,
        queue_wait_ms,
        input_resolution_ms,
        analyzer_duration_ms,
        reporter_duration_ms,
        telegram_send_duration_ms,
        total_duration_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `,
    [
      report.chatId,
      report.userId,
      report.updateId,
      report.coachMode,
      report.analyzerModel,
      report.reporterModel,
      report.userText,
      report.analysis,
      report.reply,
      report.queueWaitMs ?? null,
      report.inputResolutionMs ?? null,
      report.analyzerDurationMs ?? null,
      report.reporterDurationMs ?? null,
      report.telegramSendDurationMs ?? null,
      report.totalDurationMs ?? null
    ]
  );
};

export const listTelegramReportChatsInRange = async (
  pool: Pool,
  fromInclusive: string,
  toExclusive: string
): Promise<TelegramReportChatRef[]> => {
  const result = await pool.query(
    `
      SELECT DISTINCT ON (chat_id)
        chat_id,
        user_id
      FROM telegram_reports
      WHERE created_at >= $1
        AND created_at < $2
      ORDER BY chat_id, created_at DESC, id DESC
    `,
    [fromInclusive, toExclusive]
  );

  return (result.rows as TelegramReportChatRefRow[]).map((row) => ({
    chatId: row.chat_id,
    userId: row.user_id
  }));
};

export const listTelegramReportsByChat = async (
  pool: Pool,
  chatId: number,
  limit = 20
): Promise<TelegramReportView[]> => {
  const result = await pool.query(
    `
      SELECT
        id,
        chat_id,
        user_id,
        update_id,
        coach_mode,
        analyzer_model,
        reporter_model,
        user_text,
        analysis,
        reply,
        queue_wait_ms,
        input_resolution_ms,
        analyzer_duration_ms,
        reporter_duration_ms,
        telegram_send_duration_ms,
        total_duration_ms,
        created_at
      FROM telegram_reports
      WHERE chat_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [chatId, limit]
  );

  return (result.rows as TelegramReportRow[]).map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    updateId: row.update_id,
    coachMode: row.coach_mode,
    analyzerModel: row.analyzer_model,
    reporterModel: row.reporter_model,
    userText: row.user_text,
    analysis: row.analysis,
    reply: row.reply,
    queueWaitMs: row.queue_wait_ms,
    inputResolutionMs: row.input_resolution_ms,
    analyzerDurationMs: row.analyzer_duration_ms,
    reporterDurationMs: row.reporter_duration_ms,
    telegramSendDurationMs: row.telegram_send_duration_ms,
    totalDurationMs: row.total_duration_ms,
    createdAt: row.created_at
  }));
};

export const listTelegramReportsByChatInRange = async (
  pool: Pool,
  chatId: number,
  fromInclusive: string,
  toExclusive: string,
  limit = 200
): Promise<TelegramReportView[]> => {
  const result = await pool.query(
    `
      SELECT
        id,
        chat_id,
        user_id,
        update_id,
        coach_mode,
        analyzer_model,
        reporter_model,
        user_text,
        analysis,
        reply,
        queue_wait_ms,
        input_resolution_ms,
        analyzer_duration_ms,
        reporter_duration_ms,
        telegram_send_duration_ms,
        total_duration_ms,
        created_at
      FROM telegram_reports
      WHERE chat_id = $1
        AND created_at >= $2
        AND created_at < $3
      ORDER BY created_at ASC, id ASC
      LIMIT $4
    `,
    [chatId, fromInclusive, toExclusive, limit]
  );

  return (result.rows as TelegramReportRow[]).map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    updateId: row.update_id,
    coachMode: row.coach_mode,
    analyzerModel: row.analyzer_model,
    reporterModel: row.reporter_model,
    userText: row.user_text,
    analysis: row.analysis,
    reply: row.reply,
    queueWaitMs: row.queue_wait_ms,
    inputResolutionMs: row.input_resolution_ms,
    analyzerDurationMs: row.analyzer_duration_ms,
    reporterDurationMs: row.reporter_duration_ms,
    telegramSendDurationMs: row.telegram_send_duration_ms,
    totalDurationMs: row.total_duration_ms,
    createdAt: row.created_at
  }));
};

export const recordTelegramDailySummarySent = async (
  pool: Pool,
  summary: TelegramDailySummaryRecord
): Promise<boolean> => {
  const result = await pool.query(
    `
      INSERT INTO telegram_daily_summaries (
        chat_id,
        user_id,
        summary_date,
        timezone,
        reports_count,
        window_start_at,
        window_end_at,
        summary_text
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (chat_id, summary_date) DO NOTHING
      RETURNING 1
    `,
    [
      summary.chatId,
      summary.userId,
      summary.summaryDate,
      summary.timezone,
      summary.reportsCount,
      summary.windowStartAt,
      summary.windowEndAt,
      summary.summaryText
    ]
  );

  return (result.rowCount ?? 0) > 0;
};

export const hasTelegramDailySummaryForDate = async (
  pool: Pool,
  chatId: number,
  summaryDate: string
): Promise<boolean> => {
  const result = await pool.query(
    `
      SELECT 1
      FROM telegram_daily_summaries
      WHERE chat_id = $1
        AND summary_date = $2
      LIMIT 1
    `,
    [chatId, summaryDate]
  );

  return (result.rowCount ?? 0) > 0;
};

export const getTelegramMorningSummaryStatus = async (pool: Pool): Promise<TelegramMorningSummaryStatus> => {
  const result = await pool.query(
    `
      SELECT
        COALESCE((SELECT COUNT(*)::INT FROM telegram_daily_summaries), 0) AS total_sent,
        COALESCE(
          (
            SELECT COUNT(*)::INT
            FROM telegram_daily_summaries
            WHERE sent_at >= NOW() - INTERVAL '24 hours'
          ),
          0
        ) AS sent_last_24h,
        COALESCE(
          (
            SELECT COUNT(*)::INT
            FROM telegram_daily_summaries
            WHERE (sent_at AT TIME ZONE 'UTC')::DATE = (NOW() AT TIME ZONE 'UTC')::DATE
          ),
          0
        ) AS sent_today_utc,
        COALESCE(
          (
            SELECT COUNT(DISTINCT chat_id)::INT
            FROM telegram_daily_summaries
            WHERE sent_at >= NOW() - INTERVAL '7 days'
          ),
          0
        ) AS distinct_chats_last_7d,
        latest.sent_at AS last_sent_at,
        latest.summary_date::TEXT AS last_summary_date,
        latest.timezone AS last_timezone,
        latest.chat_id AS last_chat_id,
        latest.user_id AS last_user_id,
        latest.reports_count AS last_reports_count
      FROM (SELECT 1) AS seed
      LEFT JOIN LATERAL (
        SELECT
          sent_at,
          summary_date,
          timezone,
          chat_id,
          user_id,
          reports_count
        FROM telegram_daily_summaries
        ORDER BY sent_at DESC, id DESC
        LIMIT 1
      ) AS latest ON TRUE
    `
  );

  const row = result.rows[0] as TelegramMorningSummaryStatusRow | undefined;
  if (!row) {
    return {
      totalSent: 0,
      sentLast24h: 0,
      sentTodayUtc: 0,
      distinctChatsLast7d: 0
    };
  }

  return {
    totalSent: row.total_sent,
    sentLast24h: row.sent_last_24h,
    sentTodayUtc: row.sent_today_utc,
    distinctChatsLast7d: row.distinct_chats_last_7d,
    lastSentAt: row.last_sent_at ?? undefined,
    lastSummaryDate: row.last_summary_date ?? undefined,
    lastTimezone: row.last_timezone ?? undefined,
    lastChatId: row.last_chat_id ?? undefined,
    lastUserId: row.last_user_id ?? undefined,
    lastReportsCount: row.last_reports_count ?? undefined
  };
};
