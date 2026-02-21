import { Pool } from 'pg';

export type ChatMessageRole = 'user' | 'assistant';

export type PersistedChatMessage = {
  chatId: number;
  userId: number;
  username?: string;
  role: ChatMessageRole;
  content: string;
};

export type ChatHistoryMessage = {
  role: ChatMessageRole;
  content: string;
};

type ChatHistoryRow = {
  role: ChatMessageRole;
  content: string;
};

export const appendChatMessage = async (pool: Pool, message: PersistedChatMessage): Promise<void> => {
  await pool.query(
    `
      INSERT INTO telegram_messages (
        chat_id,
        user_id,
        username,
        role,
        content
      ) VALUES ($1, $2, $3, $4, $5)
    `,
    [message.chatId, message.userId, message.username ?? null, message.role, message.content]
  );
};

export const getRecentChatHistory = async (
  pool: Pool,
  chatId: number,
  limit = 12
): Promise<ChatHistoryMessage[]> => {
  const result = await pool.query(
    `
      SELECT role, content
      FROM (
        SELECT role, content, created_at, id
        FROM telegram_messages
        WHERE chat_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      ) AS recent
      ORDER BY created_at ASC, id ASC
    `,
    [chatId, limit]
  );

  return (result.rows as ChatHistoryRow[]).map((row) => ({
    role: row.role,
    content: row.content
  }));
};
