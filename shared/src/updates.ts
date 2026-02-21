import { Pool } from 'pg';

export const markTelegramUpdateProcessed = async (pool: Pool, updateId: number): Promise<boolean> => {
  const result = await pool.query(
    `
      INSERT INTO telegram_processed_updates (update_id)
      VALUES ($1)
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id
    `,
    [updateId]
  );

  return (result.rowCount ?? 0) > 0;
};