import { sql, type Kysely } from 'kysely';

// Hosted Postgres such as Supabase exposes the `public` schema through an auto-generated
// REST API reachable with a public key. Row level security without any policy denies those
// roles everything. The app itself connects as the table owner, which RLS does not
// restrict, so nothing changes for it (or for plain Postgres, as in docker compose).
const TABLES = [
  'competitors',
  'snapshots',
  'summary_cache',
  'kysely_migration',
  'kysely_migration_lock',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`alter table ${sql.table(table)} disable row level security`.execute(db);
  }
}
