import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Listing } from '@competitorpulse/shared';
import type { Db } from '../src/db/connection.js';
import { ListingSourceError } from '../src/listing-source/http-source.js';
import { recordSnapshot } from '../src/polling/snapshot-repo.js';
import { buildTestApp, fakeListingSource } from './helpers/app.js';
import { createTestDb, resetDb } from './helpers/db.js';

const v1: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$29/mo',
  description: 'Track leads and deals in one place.',
};

describe('competitors API', () => {
  let db: Db;
  let app: FastifyInstance;
  const onPollRequested = vi.fn();

  beforeAll(async () => {
    db = await createTestDb();
    app = await buildTestApp(db, { onPollRequested });
  });

  beforeEach(async () => {
    await resetDb(db);
    onPollRequested.mockClear();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  const track = (id: unknown) =>
    app.inject({ method: 'POST', url: '/api/competitors', payload: { id } });

  describe('POST /api/competitors', () => {
    it('starts tracking a competitor and polls it right away', async () => {
      const res = await track('acme-crm');

      expect(res.statusCode).toBe(201);
      expect(res.headers.location).toBe('/api/competitors/acme-crm');
      expect(res.json()).toMatchObject({ id: 'acme-crm' });
      expect(onPollRequested).toHaveBeenCalledOnce();
    });

    it('rejects a malformed id', async () => {
      for (const id of ['', 'Acme CRM', '-leading-dash', 'a'.repeat(64), 'acme_crm']) {
        const res = await track(id);
        expect(res.statusCode, `id ${JSON.stringify(id)}`).toBe(400);
        expect(res.json()).toMatchObject({ error: 'bad_request' });
      }
    });

    it('rejects a missing body', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/competitors' });

      expect(res.statusCode).toBe(400);
    });

    it('refuses to track the same competitor twice', async () => {
      await track('acme-crm');

      const res = await track('acme-crm');

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'conflict' });
    });

    it('refuses ids the listing source does not know', async () => {
      const res = await track('unknown-co');

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'unknown_competitor' });
    });

    it('answers 503 when the listing source cannot be reached', async () => {
      const source = fakeListingSource();
      vi.mocked(source.listCompetitorIds).mockRejectedValue(new ListingSourceError('down'));
      const isolated = await buildTestApp(db, { listingSource: source });

      const res = await isolated.inject({
        method: 'POST',
        url: '/api/competitors',
        payload: { id: 'acme-crm' },
      });

      expect(res.statusCode).toBe(503);
      await isolated.close();
    });
  });

  describe('GET /api/catalog', () => {
    it('lists trackable ids alphabetically and flags the tracked ones', async () => {
      await track('ferry-pay');

      const res = await app.inject({ method: 'GET', url: '/api/catalog' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { id: 'acme-crm', tracked: false },
        { id: 'ferry-pay', tracked: true },
        { id: 'north-analytics', tracked: false },
      ]);
    });

    it('answers 503 when the listing source cannot be reached', async () => {
      const source = fakeListingSource();
      vi.mocked(source.listCompetitorIds).mockRejectedValue(new ListingSourceError('down'));
      const isolated = await buildTestApp(db, { listingSource: source });

      const res = await isolated.inject({ method: 'GET', url: '/api/catalog' });

      expect(res.statusCode).toBe(503);
      await isolated.close();
    });
  });

  describe('GET /api/competitors', () => {
    it('lists tracked competitors in the order they were added', async () => {
      await track('north-analytics');
      await track('acme-crm');

      const res = await app.inject({ method: 'GET', url: '/api/competitors' });

      expect(res.statusCode).toBe(200);
      expect(res.json().map((c: { id: string }) => c.id)).toEqual(['north-analytics', 'acme-crm']);
      expect(res.json()[0]).toEqual({
        id: 'north-analytics',
        createdAt: expect.any(String),
        lastPolledAt: null,
        nextPollAt: expect.any(String),
        consecutiveFailures: 0,
        lastError: null,
      });
    });

    it('exposes the scheduler state of each competitor', async () => {
      await track('acme-crm');
      await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:00:00Z'));
      await db
        .updateTable('competitors')
        .set({ consecutive_failures: 2, last_error: 'Listing source answered 503' })
        .execute();

      const res = await app.inject({ method: 'GET', url: '/api/competitors' });

      expect(res.json()[0]).toMatchObject({
        lastPolledAt: '2026-09-10T12:00:00.000Z',
        consecutiveFailures: 2,
        lastError: 'Listing source answered 503',
      });
    });

    it('returns an empty list when nothing is tracked', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/competitors' });

      expect(res.json()).toEqual([]);
    });
  });

  describe('DELETE /api/competitors/:id', () => {
    it('stops tracking and removes the history', async () => {
      await track('acme-crm');
      await recordSnapshot(db, 'acme-crm', v1, new Date());

      const res = await app.inject({ method: 'DELETE', url: '/api/competitors/acme-crm' });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      const list = await app.inject({ method: 'GET', url: '/api/competitors' });
      expect(list.json()).toEqual([]);
      const snapshots = await db.selectFrom('snapshots').select('id').execute();
      expect(snapshots).toEqual([]);
    });

    it('answers 404 for a competitor that is not tracked', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/competitors/acme-crm' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/competitors/:id/snapshots', () => {
    it('returns snapshots newest first in the contract shape', async () => {
      await track('acme-crm');
      await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:00:00Z'));
      await recordSnapshot(
        db,
        'acme-crm',
        { ...v1, price: '$39/mo' },
        new Date('2026-09-10T12:15:00Z'),
      );

      const res = await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' });

      expect(res.statusCode).toBe(200);
      const [newest, oldest] = res.json();
      expect(newest).toEqual({
        id: expect.any(Number),
        fetchedAt: '2026-09-10T12:15:00.000Z',
        title: 'Acme CRM',
        tagline: 'Simple CRM for small teams',
        price: '$39/mo',
        description: 'Track leads and deals in one place.',
        changed: true,
        changedFields: ['price'],
        summary: null,
        summaryStatus: 'pending',
      });
      expect(oldest).toMatchObject({
        fetchedAt: '2026-09-10T12:00:00.000Z',
        changed: false,
        summary: null,
        summaryStatus: 'not_needed',
      });
    });

    it('exposes the summary once it is generated', async () => {
      await track('acme-crm');
      await recordSnapshot(db, 'acme-crm', v1, new Date('2026-09-10T12:00:00Z'));
      const changed = await recordSnapshot(db, 'acme-crm', { ...v1, price: '$39/mo' }, new Date());
      await db
        .updateTable('snapshots')
        .set({ summary: 'Price rose to $39/mo.', summary_status: 'done' })
        .where('id', '=', changed!.id)
        .execute();

      const res = await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' });

      expect(res.json()[0]).toMatchObject({
        summary: 'Price rose to $39/mo.',
        summaryStatus: 'done',
      });
    });

    it('honours the limit parameter', async () => {
      await track('acme-crm');
      for (let i = 0; i < 3; i++) {
        await recordSnapshot(db, 'acme-crm', v1, new Date(Date.UTC(2026, 8, 10, 12, i)));
      }

      const res = await app.inject({
        method: 'GET',
        url: '/api/competitors/acme-crm/snapshots?limit=2',
      });

      expect(res.json()).toHaveLength(2);
    });

    it('answers 404 for a competitor that is not tracked', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/competitors/nope/snapshots' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
    });
  });

  describe('POST /api/competitors/:id/poll', () => {
    it('makes the competitor due immediately', async () => {
      await track('acme-crm');
      await db
        .updateTable('competitors')
        .set({ next_poll_at: new Date(Date.now() + 3_600_000) })
        .execute();
      onPollRequested.mockClear();

      const res = await app.inject({ method: 'POST', url: '/api/competitors/acme-crm/poll' });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ id: 'acme-crm', status: 'queued', retryAfterSeconds: 10 });
      const row = await db
        .selectFrom('competitors')
        .select('next_poll_at')
        .executeTakeFirstOrThrow();
      expect(row.next_poll_at.getTime()).toBeLessThanOrEqual(Date.now());
      expect(onPollRequested).toHaveBeenCalledOnce();
    });

    it('answers 404 for a competitor that is not tracked', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/competitors/nope/poll' });

      expect(res.statusCode).toBe(404);
    });

    const pollNow = () => app.inject({ method: 'POST', url: '/api/competitors/acme-crm/poll' });

    it('rejects a second request within the cooldown without making the competitor due', async () => {
      await track('acme-crm');
      await pollNow();
      const later = new Date(Date.now() + 3_600_000);
      await db.updateTable('competitors').set({ next_poll_at: later }).execute();
      onPollRequested.mockClear();

      const res = await pollNow();

      expect(res.statusCode).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(10);
      expect(res.json()).toMatchObject({
        error: 'too_many_requests',
        retryAfterSeconds: Number(res.headers['retry-after']),
      });
      const row = await db
        .selectFrom('competitors')
        .select('next_poll_at')
        .executeTakeFirstOrThrow();
      expect(row.next_poll_at).toEqual(later);
      expect(onPollRequested).not.toHaveBeenCalled();
    });

    it('accepts requests again once the cooldown has passed', async () => {
      await track('acme-crm');
      await pollNow();
      await db
        .updateTable('competitors')
        .set({ last_manual_poll_at: new Date(Date.now() - 11_000) })
        .execute();

      const res = await pollNow();

      expect(res.statusCode).toBe(202);
    });

    it('lets exactly one of many simultaneous requests through', async () => {
      await track('acme-crm');

      const responses = await Promise.all(Array.from({ length: 20 }, () => pollNow()));

      const codes = responses.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 202)).toHaveLength(1);
      expect(codes.filter((c) => c === 429)).toHaveLength(19);
    });

    it('limits competitors whose fetches keep failing as well', async () => {
      await track('acme-crm');
      await db
        .updateTable('competitors')
        .set({ last_polled_at: null, consecutive_failures: 7, last_error: 'down' })
        .execute();

      await pollNow();
      const res = await pollNow();

      expect(res.statusCode).toBe(429);
    });
  });

  it('names client errors after their status code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/competitors',
      headers: { 'content-type': 'application/xml' },
      payload: '<id>acme-crm</id>',
    });

    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: 'unsupported_media_type' });
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});
