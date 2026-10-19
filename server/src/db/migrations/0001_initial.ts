import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table competitors (
      id text primary key,
      created_at timestamptz not null default now(),
      next_poll_at timestamptz not null default now(),
      last_polled_at timestamptz,
      consecutive_failures integer not null default 0,
      last_error text
    )
  `.execute(db);
  await sql`create index competitors_next_poll_at_idx on competitors (next_poll_at)`.execute(db);

  await sql`
    create table snapshots (
      id bigint generated always as identity primary key,
      competitor_id text not null references competitors (id) on delete cascade,
      fetched_at timestamptz not null,
      title text not null,
      tagline text not null,
      price text not null,
      description text not null,
      content_hash text not null,
      changed boolean not null,
      changed_fields text[] not null default '{}',
      previous_snapshot_id bigint references snapshots (id) on delete set null,
      summary text,
      summary_status text not null
        check (summary_status in ('not_needed', 'pending', 'done', 'failed')),
      summary_attempts integer not null default 0,
      summary_next_attempt_at timestamptz,
      summary_error text,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  // Serves both the timeline query and "latest snapshot for competitor X".
  await sql`
    create index snapshots_competitor_timeline_idx
      on snapshots (competitor_id, fetched_at desc, id desc)
  `.execute(db);
  // Keeps the summary worker's "what is due?" query cheap no matter how many snapshots exist.
  await sql`
    create index snapshots_pending_summary_idx
      on snapshots (summary_next_attempt_at)
      where summary_status = 'pending'
  `.execute(db);

  await sql`
    create table summary_cache (
      from_hash text not null,
      to_hash text not null,
      model text not null,
      summary text not null,
      created_at timestamptz not null default now(),
      primary key (from_hash, to_hash, model)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table summary_cache`.execute(db);
  await sql`drop table snapshots`.execute(db);
  await sql`drop table competitors`.execute(db);
}
