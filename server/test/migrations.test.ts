import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Db } from '../src/db/connection.js';
import { migrateToLatest } from '../src/db/migrator.js';
import { createTestDb } from './helpers/db.js';

describe('migrations', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('creates the expected tables', async () => {
    const { rows } = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name not like 'kysely_%'
      order by table_name
    `.execute(db);

    expect(rows.map((r) => r.table_name)).toEqual(['competitors', 'snapshots', 'summary_cache']);
  });

  it('enables row level security on every table', async () => {
    const { rows } = await sql<{ relname: string; relrowsecurity: boolean }>`
      select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r'
    `.execute(db);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it('is idempotent', async () => {
    await expect(migrateToLatest(db)).resolves.toEqual([]);
  });

  it('removes snapshots together with their competitor', async () => {
    await db.insertInto('competitors').values({ id: 'cascade-check' }).execute();
    await db
      .insertInto('snapshots')
      .values({
        competitor_id: 'cascade-check',
        fetched_at: new Date(),
        title: 't',
        tagline: 't',
        price: 'p',
        description: 'd',
        content_hash: 'h',
        changed: false,
        changed_fields: [],
        previous_snapshot_id: null,
        summary: null,
        summary_status: 'not_needed',
        summary_next_attempt_at: null,
        summary_error: null,
      })
      .execute();

    await db.deleteFrom('competitors').where('id', '=', 'cascade-check').execute();

    const remaining = await db
      .selectFrom('snapshots')
      .select('id')
      .where('competitor_id', '=', 'cascade-check')
      .execute();
    expect(remaining).toHaveLength(0);
  });
});
