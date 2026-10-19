import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import type { Listing } from '@competitorpulse/shared';
import type { Db } from '../src/db/connection.js';
import {
  ListingNotFoundError,
  ListingSourceError,
  type ListingSource,
} from '../src/listing-source/http-source.js';
import { Poller } from '../src/polling/poller.js';
import { createTestDb, resetDb } from './helpers/db.js';

const listing = (price: string): Listing => ({
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price,
  description: 'Track leads and deals in one place.',
});

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function fakeSource(impl: (id: string) => Promise<Listing>): ListingSource {
  return { fetchListing: vi.fn(impl), hasCompetitor: vi.fn(async () => true) };
}

async function secondsUntilNextPoll(db: Db, id: string): Promise<number> {
  const { rows } = await sql<{ s: number }>`
    select extract(epoch from next_poll_at - now())::float8 as s from competitors where id = ${id}
  `.execute(db);
  return rows[0]!.s;
}

describe('Poller', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await resetDb(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  const makePoller = (source: ListingSource, overrides: Partial<{ batchSize: number }> = {}) =>
    new Poller({
      db,
      source,
      log,
      intervalSeconds: 900,
      batchSize: overrides.batchSize ?? 50,
      concurrency: 4,
      failureBaseSeconds: 15,
    });

  it('claims only competitors that are due and schedules their next poll', async () => {
    await db
      .insertInto('competitors')
      .values([{ id: 'due' }, { id: 'later', next_poll_at: sql<Date>`now() + interval '1 hour'` }])
      .execute();
    const poller = makePoller(fakeSource(async () => listing('$1')));

    const claimed = await poller.claimDue();

    expect(claimed).toEqual(['due']);
    const wait = await secondsUntilNextPoll(db, 'due');
    expect(wait).toBeGreaterThan(899);
    expect(wait).toBeLessThan(900 * 1.1 + 1);
  });

  it('never hands the same competitor to two concurrent claimers', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => ({ id: `c-${i}` }));
    await db.insertInto('competitors').values(ids).execute();
    const a = makePoller(
      fakeSource(async () => listing('$1')),
      { batchSize: 20 },
    );
    const b = makePoller(
      fakeSource(async () => listing('$1')),
      { batchSize: 20 },
    );

    const [first, second] = await Promise.all([a.claimDue(), b.claimDue()]);

    const overlap = first.filter((id) => second.includes(id));
    expect(overlap).toEqual([]);
    expect(new Set([...first, ...second]).size).toBe(30);
  });

  it('records a snapshot for every due competitor', async () => {
    await db
      .insertInto('competitors')
      .values([{ id: 'a' }, { id: 'b' }])
      .execute();
    const poller = makePoller(fakeSource(async (id) => listing(`$${id}`)));

    const result = await poller.runOnce();

    expect(result).toEqual({ claimed: 2, recorded: 2, failed: 0 });
    const prices = await db.selectFrom('snapshots').select('price').orderBy('price').execute();
    expect(prices.map((p) => p.price)).toEqual(['$a', '$b']);
  });

  it('backs off a failing competitor without writing a snapshot or blocking others', async () => {
    await db
      .insertInto('competitors')
      .values([{ id: 'broken' }, { id: 'fine' }])
      .execute();
    const poller = makePoller(
      fakeSource(async (id) => {
        if (id === 'broken') throw new ListingSourceError('Listing source answered 503');
        return listing('$1');
      }),
    );

    const result = await poller.runOnce();

    expect(result).toEqual({ claimed: 2, recorded: 1, failed: 1 });
    const broken = await db
      .selectFrom('competitors')
      .selectAll()
      .where('id', '=', 'broken')
      .executeTakeFirstOrThrow();
    expect(broken).toMatchObject({
      consecutive_failures: 1,
      last_error: 'Listing source answered 503',
    });
    const wait = await secondsUntilNextPoll(db, 'broken');
    expect(wait).toBeGreaterThan(13);
    expect(wait).toBeLessThan(16);
    const snapshots = await db
      .selectFrom('snapshots')
      .select('competitor_id')
      .where('competitor_id', '=', 'broken')
      .execute();
    expect(snapshots).toEqual([]);
  });

  it('doubles the retry delay with consecutive failures, capped at the poll interval', async () => {
    await db.insertInto('competitors').values({ id: 'gone', consecutive_failures: 10 }).execute();
    const poller = makePoller(
      fakeSource(async () => {
        throw new ListingNotFoundError('No listing found for gone');
      }),
    );

    await poller.runOnce();

    const wait = await secondsUntilNextPoll(db, 'gone');
    expect(wait).toBeGreaterThan(898);
    expect(wait).toBeLessThan(901);
  });

  it('tolerates a competitor being removed while its listing is being fetched', async () => {
    await db.insertInto('competitors').values({ id: 'acme' }).execute();
    const poller = makePoller(
      fakeSource(async () => {
        await db.deleteFrom('competitors').where('id', '=', 'acme').execute();
        return listing('$1');
      }),
    );

    await expect(poller.runOnce()).resolves.toEqual({ claimed: 1, recorded: 0, failed: 0 });
  });
});
