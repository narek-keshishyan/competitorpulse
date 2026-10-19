import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { ListingField, SummaryStatus } from '@competitorpulse/shared';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface CompetitorsTable {
  id: string;
  created_at: Generated<Date>;
  next_poll_at: Timestamp;
  last_polled_at: Date | null;
  consecutive_failures: Generated<number>;
  last_error: string | null;
}

export interface SnapshotsTable {
  id: Generated<number>;
  competitor_id: string;
  fetched_at: Date;
  title: string;
  tagline: string;
  price: string;
  description: string;
  content_hash: string;
  changed: boolean;
  changed_fields: ListingField[];
  previous_snapshot_id: number | null;
  summary: string | null;
  summary_status: SummaryStatus;
  summary_attempts: Generated<number>;
  summary_next_attempt_at: Date | null;
  summary_error: string | null;
  created_at: Generated<Date>;
}

export interface SummaryCacheTable {
  from_hash: string;
  to_hash: string;
  model: string;
  summary: string;
  created_at: Generated<Date>;
}

export interface Database {
  competitors: CompetitorsTable;
  snapshots: SnapshotsTable;
  summary_cache: SummaryCacheTable;
}

export type CompetitorRow = Selectable<CompetitorsTable>;
export type SnapshotRow = Selectable<SnapshotsTable>;
export type NewSnapshot = Insertable<SnapshotsTable>;
