import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import type { Listing } from '@competitorpulse/shared';
import type { Db } from '../src/db/connection.js';
import { recordSnapshot } from '../src/polling/snapshot-repo.js';
import { LlmError, type ChatMessage, type LlmClient } from '../src/summaries/llm-client.js';
import { SummaryWorker } from '../src/summaries/summary-worker.js';
import { createTestDb, resetDb } from './helpers/db.js';

const v1: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$39/mo',
  description: 'Track leads and deals in one place.',
};
const v2: Listing = { ...v1, price: '$29/mo' };

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function fakeLlm(impl: (messages: ChatMessage[]) => Promise<string>) {
  const complete = vi.fn(impl);
  const client: LlmClient = { model: 'fake-model', complete };
  return { client, complete };
}

describe('SummaryWorker', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await resetDb(db);
    await db
      .insertInto('competitors')
      .values([{ id: 'acme-crm' }, { id: 'acme-clone' }])
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  const makeWorker = (llm: LlmClient, maxAttempts = 3) =>
    new SummaryWorker({
      db,
      llm,
      log,
      concurrency: 2,
      maxAttempts,
      retryBaseMs: 10_000,
      retryMaxMs: 60_000,
      leaseMs: 60_000,
      random: () => 1,
    });

  async function recordChange(competitorId = 'acme-crm') {
    await recordSnapshot(db, competitorId, v1, new Date('2026-09-10T12:00:00Z'));
    return (await recordSnapshot(db, competitorId, v2, new Date('2026-09-10T12:15:00Z')))!;
  }

  const load = (id: number) =>
    db.selectFrom('snapshots').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  const makeDueNow = (id: number) =>
    db
      .updateTable('snapshots')
      .set({ summary_next_attempt_at: sql<Date>`now()` })
      .where('id', '=', id)
      .execute();

  it('stores the generated summary on the changed snapshot', async () => {
    const snapshot = await recordChange();
    const llm = fakeLlm(async () => 'Price dropped from $39/mo to $29/mo.');

    const result = await makeWorker(llm.client).runOnce();

    expect(result).toEqual({ claimed: 1, done: 1, retrying: 0, failed: 0 });
    expect(await load(snapshot.id)).toMatchObject({
      summary: 'Price dropped from $39/mo to $29/mo.',
      summary_status: 'done',
      summary_attempts: 1,
      summary_next_attempt_at: null,
      summary_error: null,
    });
    const userMessage = llm.complete.mock.calls[0]![0][1]!.content;
    expect(userMessage).toContain('price: "$39/mo" -> "$29/mo"');
  });

  it('never calls the LLM when nothing changed', async () => {
    await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:00:00Z'));
    await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:15:00Z'));
    const llm = fakeLlm(async () => 'unused');

    const result = await makeWorker(llm.client).runOnce();

    expect(result.claimed).toBe(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('keeps the snapshot and schedules a retry when the LLM fails', async () => {
    const snapshot = await recordChange();
    const llm = fakeLlm(async () => {
      throw new LlmError('LLM answered 500: injected failure', true, 500);
    });

    const result = await makeWorker(llm.client).runOnce();

    expect(result).toEqual({ claimed: 1, done: 0, retrying: 1, failed: 0 });
    const row = await load(snapshot.id);
    expect(row).toMatchObject({
      price: '$29/mo',
      changed: true,
      summary: null,
      summary_status: 'pending',
      summary_attempts: 1,
      summary_error: 'LLM answered 500: injected failure',
    });
    const waitMs = row.summary_next_attempt_at!.getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(8_000);
    expect(waitMs).toBeLessThan(11_000);
  });

  it('gives up after the maximum number of attempts', async () => {
    const snapshot = await recordChange();
    const llm = fakeLlm(async () => {
      throw new LlmError('LLM request timed out after 15000ms', true);
    });
    const worker = makeWorker(llm.client, 2);

    await worker.runOnce();
    await makeDueNow(snapshot.id);
    const result = await worker.runOnce();

    expect(result.failed).toBe(1);
    expect(await load(snapshot.id)).toMatchObject({
      summary_status: 'failed',
      summary_attempts: 2,
      summary_next_attempt_at: null,
      summary_error: 'LLM request timed out after 15000ms',
    });
  });

  it('fails immediately on errors that retrying cannot fix', async () => {
    const snapshot = await recordChange();
    const llm = fakeLlm(async () => {
      throw new LlmError('LLM answered 401', false, 401);
    });

    await makeWorker(llm.client).runOnce();

    expect(await load(snapshot.id)).toMatchObject({
      summary_status: 'failed',
      summary_attempts: 1,
    });
  });

  it('reuses the summary of an identical transition instead of paying for another call', async () => {
    const llm = fakeLlm(async () => 'Price dropped from $39/mo to $29/mo.');
    const worker = makeWorker(llm.client);
    const first = await recordChange('acme-crm');
    await worker.runOnce();

    const second = await recordChange('acme-clone');
    await worker.runOnce();

    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect((await load(first.id)).summary).toBe('Price dropped from $39/mo to $29/mo.');
    expect((await load(second.id)).summary).toBe('Price dropped from $39/mo to $29/mo.');
  });

  it('does not hand a job that is being worked on to another worker', async () => {
    await recordChange();
    const llm = fakeLlm(async () => 'ok');

    const first = await makeWorker(llm.client).claimDue();
    const second = await makeWorker(llm.client).claimDue();

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('claims no more jobs than it calls in parallel, so leases start with the call', async () => {
    for (const id of ['a', 'b', 'c']) {
      await db.insertInto('competitors').values({ id }).execute();
      await recordChange(id);
    }
    const llm = fakeLlm(async () => 'ok');

    const claimed = await makeWorker(llm.client).claimDue();

    expect(claimed).toHaveLength(2);
  });

  it('ignores a late result once another worker has re-claimed the job', async () => {
    const snapshot = await recordChange();
    let release: () => void = () => {};
    const slow = fakeLlm(
      () => new Promise<string>((resolve) => (release = () => resolve('stale result'))),
    );
    const fast = fakeLlm(async () => 'fresh result');

    const slowRun = makeWorker(slow.client).runOnce();
    await vi.waitFor(() => expect(slow.complete).toHaveBeenCalled());
    // The slow worker's lease expires and a second worker takes over and finishes.
    await makeDueNow(snapshot.id);
    await makeWorker(fast.client).runOnce();
    release();
    await slowRun;

    expect(await load(snapshot.id)).toMatchObject({
      summary: 'fresh result',
      summary_status: 'done',
      summary_attempts: 2,
    });
  });

  it('tolerates the competitor being removed while the summary is generated', async () => {
    await recordChange();
    const llm = fakeLlm(async () => {
      await db.deleteFrom('competitors').where('id', '=', 'acme-crm').execute();
      return 'too late';
    });

    await expect(makeWorker(llm.client).runOnce()).resolves.toMatchObject({ claimed: 1 });
  });
});
