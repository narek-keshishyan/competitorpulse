import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/connection.js';
import { fakeListingSource } from './helpers/app.js';
import { createTestDb, resetDb } from './helpers/db.js';

describe('abuse protection', () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    await resetDb(db);
    // A fresh app per test gives every test fresh rate-limit counters.
    app = await buildApp({
      db,
      listingSource: fakeListingSource(),
      rateLimit: { perMinute: 3, writesPerMinute: 2 },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await db.destroy();
  });

  const get = (ip = '203.0.113.1') =>
    app.inject({ method: 'GET', url: '/api/competitors', headers: { 'fly-client-ip': ip } });

  it('limits API requests per client and says when to retry', async () => {
    for (let i = 0; i < 3; i++) expect((await get()).statusCode).toBe(200);

    const res = await get();

    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json()).toMatchObject({ error: 'too_many_requests' });
  });

  it('counts each client separately', async () => {
    for (let i = 0; i < 3; i++) await get('203.0.113.1');

    expect((await get('203.0.113.2')).statusCode).toBe(200);
  });

  it('applies a stricter limit to endpoints that change data', async () => {
    const track = () =>
      app.inject({
        method: 'POST',
        url: '/api/competitors',
        headers: { 'fly-client-ip': '203.0.113.1' },
        payload: { id: 'acme-crm' },
      });

    await track();
    await track();
    const res = await track();

    expect(res.statusCode).toBe(429);
  });

  it('never limits health probes', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
  });

  it('refuses oversized request bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/competitors',
      payload: { id: 'x'.repeat(20_000) },
    });

    expect(res.statusCode).toBe(413);
  });

  it('sends security headers', async () => {
    const res = await get();

    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
