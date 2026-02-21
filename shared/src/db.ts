import { Pool } from 'pg';

export const createDbPool = (databaseUrl: string) =>
  new Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

export const checkDbHealth = async (pool: Pool): Promise<void> => {
  await pool.query('SELECT 1');
};