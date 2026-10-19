import { sql } from 'kysely';
import type { Db } from '../db/connection.js';
import type { ListingSource } from '../listing-source/http-source.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import type { Logger } from '../lib/logger.js';
import { recordSnapshot } from './snapshot-repo.js';

export interface PollerOptions {
  db: Db;
  source: ListingSource;
  log: Logger;
  intervalSeconds: number;
  /** Max competitors claimed per run. */
  batchSize: number;
  /** Max listing fetches in flight at once. */
  concurrency: number;
  /** First retry delay after a failed fetch; doubles per consecutive failure. */
  failureBaseSeconds?: number;
}

export interface PollRunResult {
  claimed: number;
  recorded: number;
  failed: number;
}

/**
 * Polls every tracked competitor on its own schedule.
 *
 * Each competitor row carries `next_poll_at`. A run atomically claims the rows that are
 * due (`FOR UPDATE SKIP LOCKED`) and pushes their `next_poll_at` forward in the same
 * statement, so any number of app instances can poll side by side without fetching the
 * same competitor twice and without a separate lock service. A small random jitter keeps
 * competitors added at the same time from staying in lockstep forever.
 */
export class Poller {
  private readonly failureBaseSeconds: number;

  constructor(private readonly options: PollerOptions) {
    this.failureBaseSeconds = options.failureBaseSeconds ?? 15;
  }

  async claimDue(): Promise<string[]> {
    const { db, intervalSeconds, batchSize } = this.options;
    const rows = await db
      .updateTable('competitors')
      .set({
        next_poll_at: sql<Date>`now() + make_interval(secs => ${intervalSeconds}::float8 * (1 + random() * 0.1))`,
      })
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('competitors')
          .select('id')
          .where('next_poll_at', '<=', sql<Date>`now()`)
          .orderBy('next_poll_at')
          .limit(batchSize)
          .forUpdate()
          .skipLocked(),
      )
      .returning('id')
      .execute();
    return rows.map((r) => r.id);
  }

  async runOnce(): Promise<PollRunResult> {
    const ids = await this.claimDue();
    const outcomes = await mapWithConcurrency(ids, this.options.concurrency, (id) =>
      this.pollCompetitor(id),
    );

    const result: PollRunResult = { claimed: ids.length, recorded: 0, failed: 0 };
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') result.failed += 1;
      else if (outcome.value === 'recorded') result.recorded += 1;
      else if (outcome.value === 'failed') result.failed += 1;
    }
    if (ids.length > 0) this.options.log.info(result, 'poll run finished');
    return result;
  }

  private async pollCompetitor(id: string): Promise<'recorded' | 'gone' | 'failed'> {
    const { db, source, log } = this.options;
    let listing;
    try {
      listing = await source.fetchListing(id);
    } catch (err) {
      await this.recordFailure(id, err);
      log.warn({ err, competitorId: id }, 'listing fetch failed');
      return 'failed';
    }

    const snapshot = await recordSnapshot(db, id, listing);
    if (!snapshot) return 'gone';
    if (snapshot.changed) {
      log.info(
        { competitorId: id, changedFields: snapshot.changed_fields },
        'listing changed; summary queued',
      );
    }
    return 'recorded';
  }

  /**
   * Retries sooner than the regular interval, backing off exponentially while the source
   * keeps failing, but never waits longer than a normal poll would.
   */
  private async recordFailure(id: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const { intervalSeconds } = this.options;
    await this.options.db
      .updateTable('competitors')
      .set((eb) => ({
        consecutive_failures: eb('consecutive_failures', '+', 1),
        last_error: message,
        next_poll_at: sql<Date>`now() + make_interval(secs => least(
          ${intervalSeconds}::float8,
          ${this.failureBaseSeconds}::float8 * power(2, consecutive_failures)
        ))`,
      }))
      .where('id', '=', id)
      .execute();
  }
}
