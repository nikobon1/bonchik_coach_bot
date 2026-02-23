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
