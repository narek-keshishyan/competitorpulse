import { sql, type Kysely } from 'kysely';

// Deleting a competitor cascades to its snapshots, and every deleted snapshot makes
// Postgres look for rows whose previous_snapshot_id points at it. Without an index that is
// a full scan per deleted row, which gets slow once timelines are long.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index snapshots_previous_snapshot_id_idx on snapshots (previous_snapshot_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index snapshots_previous_snapshot_id_idx`.execute(db);
}
