import { sql } from 'kysely';
import type { Listing, ListingField } from '@competitorpulse/shared';
import type { Db } from '../db/connection.js';
import { backoffMs } from '../lib/backoff.js';
import type { Logger } from '../lib/logger.js';
import { LlmError, type LlmClient } from './llm-client.js';
import { buildSummaryMessages } from './prompt.js';

export interface SummaryWorkerOptions {
  db: Db;
  llm: LlmClient;
  log: Logger;
  /** Max LLM calls in flight; also how many jobs one run claims. */
  concurrency: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /**
   * How long a claimed job is reserved for this worker. If the process dies mid-call the
   * job becomes due again after the lease, so it must comfortably exceed the LLM timeout.
   */
  leaseMs: number;
  random?: () => number;
}

interface SummaryJob {
  id: number;
  attempts: number;
  changedFields: ListingField[];
  current: Listing;
  currentHash: string;
  previous: Listing | null;
  previousHash: string | null;
}

export interface SummaryRunResult {
  claimed: number;
  done: number;
  retrying: number;
  failed: number;
}

type Outcome = 'done' | 'retrying' | 'failed';

/**
 * Generates AI summaries for changed snapshots, decoupled from polling.
 *
 * Snapshots are committed before any LLM call, so a slow or failing model can delay a
 * summary but never lose a snapshot. Jobs are claimed with `FOR UPDATE SKIP LOCKED` plus
 * a lease (multiple workers are safe), retried with exponential backoff, and marked
 * `failed` after `maxAttempts`. Identical transitions are answered from a cache, since
 * every LLM call is billed.
 *
 * A run claims only as many jobs as it calls in parallel, so each lease starts when its
 * call starts. Claiming increments `summary_attempts`, which doubles as a fencing token:
 * every later write requires the attempt number we claimed, so a worker whose lease
 * expired can never overwrite the job after another worker re-claimed it.
 */
export class SummaryWorker {
  constructor(private readonly options: SummaryWorkerOptions) {}

  async claimDue(): Promise<number[]> {
    const { db, concurrency, leaseMs } = this.options;
    const rows = await db
      .updateTable('snapshots')
      .set((eb) => ({
        summary_attempts: eb('summary_attempts', '+', 1),
        summary_next_attempt_at: sql<Date>`now() + make_interval(secs => ${leaseMs / 1000}::float8)`,
      }))
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('snapshots')
          .select('id')
          .where('summary_status', '=', 'pending')
          .where('summary_next_attempt_at', '<=', sql<Date>`now()`)
          .orderBy('summary_next_attempt_at')
          .limit(concurrency)
          .forUpdate()
          .skipLocked(),
      )
      .returning('id')
      .execute();
    return rows.map((r) => r.id);
  }

  async runOnce(): Promise<SummaryRunResult> {
    const ids = await this.claimDue();
    const result: SummaryRunResult = { claimed: ids.length, done: 0, retrying: 0, failed: 0 };
    if (ids.length === 0) return result;

    const jobs = await this.loadJobs(ids);
    const outcomes = await Promise.allSettled(jobs.map((job) => this.process(job)));
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') result[outcome.value] += 1;
      else this.options.log.error({ err: outcome.reason }, 'summary job crashed');
    }
    this.options.log.info(result, 'summary run finished');
    return result;
  }

  private async loadJobs(ids: number[]): Promise<SummaryJob[]> {
    const rows = await this.options.db
      .selectFrom('snapshots as s')
      .leftJoin('snapshots as p', 'p.id', 's.previous_snapshot_id')
      .select([
        's.id',
        's.summary_attempts',
        's.changed_fields',
        's.title',
        's.tagline',
        's.price',
        's.description',
        's.content_hash',
        'p.title as prev_title',
        'p.tagline as prev_tagline',
        'p.price as prev_price',
        'p.description as prev_description',
        'p.content_hash as prev_hash',
      ])
      .where('s.id', 'in', ids)
      .execute();

    return rows.map((r) => ({
      id: r.id,
      attempts: r.summary_attempts,
      changedFields: r.changed_fields,
      current: { title: r.title, tagline: r.tagline, price: r.price, description: r.description },
      currentHash: r.content_hash,
      previous:
        r.prev_hash === null
          ? null
          : {
              title: r.prev_title ?? '',
              tagline: r.prev_tagline ?? '',
              price: r.prev_price ?? '',
              description: r.prev_description ?? '',
            },
      previousHash: r.prev_hash,
    }));
  }

  private async process(job: SummaryJob): Promise<Outcome> {
    const { llm, log } = this.options;
    if (!job.previous || !job.previousHash) {
      await this.markFailed(job, 'Previous snapshot is missing');
      return 'failed';
    }

    const cached = await this.findCached(job.previousHash, job.currentHash);
    if (cached) {
      await this.markDone(job, cached);
      log.debug({ snapshotId: job.id }, 'summary served from cache');
      return 'done';
    }

    let summary: string;
    try {
      summary = await llm.complete(
        buildSummaryMessages(job.previous, job.current, job.changedFields),
      );
    } catch (err) {
      return this.handleLlmFailure(job, err);
    }

    // Database writes stay outside the LLM error handling: a failed write must not be
    // mistaken for a failed (and billed) LLM call and trigger another one.
    await this.markDone(job, summary);
    try {
      await this.cache(job.previousHash, job.currentHash, summary);
    } catch (err) {
      log.warn({ snapshotId: job.id, err }, 'could not cache summary');
    }
    return 'done';
  }

  private async handleLlmFailure(job: SummaryJob, err: unknown): Promise<Outcome> {
    const { log, maxAttempts } = this.options;
    const message = err instanceof Error ? err.message : String(err);
    const retryable = !(err instanceof LlmError) || err.retryable;
    if (!retryable || job.attempts >= maxAttempts) {
      await this.markFailed(job, message);
      log.warn({ snapshotId: job.id, attempts: job.attempts, err }, 'summary failed for good');
      return 'failed';
    }
    await this.scheduleRetry(job, message);
    log.warn({ snapshotId: job.id, attempts: job.attempts, err }, 'summary failed; will retry');
    return 'retrying';
  }

  private async findCached(fromHash: string, toHash: string): Promise<string | undefined> {
    const row = await this.options.db
      .selectFrom('summary_cache')
      .select('summary')
      .where('from_hash', '=', fromHash)
      .where('to_hash', '=', toHash)
      .where('model', '=', this.options.llm.model)
      .executeTakeFirst();
    return row?.summary;
  }

  private async cache(fromHash: string, toHash: string, summary: string): Promise<void> {
    await this.options.db
      .insertInto('summary_cache')
      .values({ from_hash: fromHash, to_hash: toHash, model: this.options.llm.model, summary })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  /** Updates the job only if we still own it: still pending and not re-claimed since. */
  private updateOwnedJob(job: SummaryJob) {
    return this.options.db
      .updateTable('snapshots')
      .where('id', '=', job.id)
      .where('summary_status', '=', 'pending')
      .where('summary_attempts', '=', job.attempts);
  }

  private async markDone(job: SummaryJob, summary: string): Promise<void> {
    await this.updateOwnedJob(job)
      .set({
        summary,
        summary_status: 'done',
        summary_error: null,
        summary_next_attempt_at: null,
      })
      .execute();
  }

  private async markFailed(job: SummaryJob, error: string): Promise<void> {
    await this.updateOwnedJob(job)
      .set({ summary_status: 'failed', summary_error: error, summary_next_attempt_at: null })
      .execute();
  }

  private async scheduleRetry(job: SummaryJob, error: string): Promise<void> {
    const delay = backoffMs(job.attempts, {
      baseMs: this.options.retryBaseMs,
      maxMs: this.options.retryMaxMs,
      random: this.options.random,
    });
    await this.updateOwnedJob(job)
      .set({
        summary_error: error,
        summary_next_attempt_at: sql<Date>`now() + make_interval(secs => ${delay / 1000}::float8)`,
      })
      .execute();
  }
}
