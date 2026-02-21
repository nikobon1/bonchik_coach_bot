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
  createdAt: string;
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
  created_at: string;
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
        reply
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      report.reply
    ]
  );
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
    createdAt: row.created_at
  }));
};
