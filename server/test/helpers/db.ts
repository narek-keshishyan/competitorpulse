import { sql } from 'kysely';
import { createDb, type Db } from '../../src/db/connection.js';
import { migrateToLatest } from '../../src/db/migrator.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/competitorpulse_test';

export async function createTestDb(): Promise<Db> {
  const db = createDb({ url: TEST_DATABASE_URL, poolMax: 5 });
  await migrateToLatest(db);
  return db;
}

export async function resetDb(db: Db): Promise<void> {
  await sql`truncate table summary_cache, snapshots, competitors restart identity cascade`.execute(
    db,
  );
}
