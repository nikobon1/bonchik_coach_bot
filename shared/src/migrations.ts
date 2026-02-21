import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const MIGRATIONS_LOCK_KEY = 584221;

type MigrationFile = {
  id: string;
  fullPath: string;
};

const listMigrationFiles = async (): Promise<MigrationFile[]> => {
  let entries;
  try {
    entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => ({
      id: entry.name,
      fullPath: path.join(MIGRATIONS_DIR, entry.name)
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
};

export const runMigrations = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK_KEY]);

  try {
    const migrationFiles = await listMigrationFiles();

    for (const migration of migrationFiles) {
      const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1 LIMIT 1', [migration.id]);
      if ((existing.rowCount ?? 0) > 0) {
        continue;
      }

      const sql = await readFile(migration.fullPath, 'utf8');
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration failed: ${migration.id}`, { cause: error });
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_KEY]);
  }
};
