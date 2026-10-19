import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Listing } from '@competitorpulse/shared';
import type { Db } from '../src/db/connection.js';
import { recordSnapshot } from '../src/polling/snapshot-repo.js';
import { createTestDb, resetDb } from './helpers/db.js';

const v1: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$29/mo',
  description: 'Track leads and deals in one place.',
};
const v2: Listing = { ...v1, price: '$39/mo' };

describe('recordSnapshot', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await resetDb(db);
    await db.insertInto('competitors').values({ id: 'acme-crm' }).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('stores the first snapshot as unchanged with no summary needed', async () => {
    const snap = await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:00:00Z'));

    expect(snap).toMatchObject({
      changed: false,
      changed_fields: [],
      summary_status: 'not_needed',
      previous_snapshot_id: null,
      price: '$29/mo',
    });
  });

  it('marks a changed listing as pending a summary', async () => {
    const first = await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:00:00Z'));
    const second = await recordSnapshot(db, 'acme-crm', v2, new Date('2026-09-10T12:15:00Z'));

    expect(second).toMatchObject({
      changed: true,
      changed_fields: ['price'],
      summary_status: 'pending',
      previous_snapshot_id: first?.id,
    });
    expect(second?.summary_next_attempt_at).toBeInstanceOf(Date);
  });

  it('persists unchanged polls too, so the timeline is complete', async () => {
    await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:00:00Z'));
    const again = await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:15:00Z'));

    expect(again).toMatchObject({ changed: false, summary_status: 'not_needed' });
    const count = await db
      .selectFrom('snapshots')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(2);
  });

  it('compares against the most recent snapshot by fetch time', async () => {
    await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:00:00Z'));
    const latest = await recordSnapshot(db, 'acme-crm', v2, new Date('2026-09-10T12:15:00Z'));
    const next = await recordSnapshot(db, 'acme-crm', v2, new Date('2026-09-10T12:30:00Z'));

    expect(next).toMatchObject({ changed: false, previous_snapshot_id: latest?.id });
  });

  it('resets the failure counters on the competitor', async () => {
    await db
      .updateTable('competitors')
      .set({ consecutive_failures: 3, last_error: 'boom' })
      .where('id', '=', 'acme-crm')
      .execute();
    const fetchedAt = new Date('2026-09-10T12:00:00Z');

    await recordSnapshot(db, 'acme-crm', v1, fetchedAt);

    const competitor = await db
      .selectFrom('competitors')
      .selectAll()
      .where('id', '=', 'acme-crm')
      .executeTakeFirstOrThrow();
    expect(competitor).toMatchObject({
      consecutive_failures: 0,
      last_error: null,
      last_polled_at: fetchedAt,
    });
  });

  it('stamps the fetch time with the database clock by default', async () => {
    const before = await db
      .selectNoFrom((eb) => eb.fn<Date>('now').as('t'))
      .executeTakeFirstOrThrow();

    const snap = await recordSnapshot(db, 'acme-crm', v1);

    expect(snap?.fetched_at.getTime()).toBeGreaterThanOrEqual(before.t.getTime());
  });

  it('returns null when the competitor was removed in the meantime', async () => {
    await db.deleteFrom('competitors').where('id', '=', 'acme-crm').execute();

    await expect(recordSnapshot(db, 'acme-crm', v1, new Date())).resolves.toBeNull();
  });
});
