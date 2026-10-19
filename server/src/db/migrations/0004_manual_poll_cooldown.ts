import { sql, type Kysely } from 'kysely';

// When "Poll now" was last accepted for a competitor, so manual polls can be rate limited
// per competitor, independently of whether the fetches themselves succeed.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table competitors add column last_manual_poll_at timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table competitors drop column last_manual_poll_at`.execute(db);
}
