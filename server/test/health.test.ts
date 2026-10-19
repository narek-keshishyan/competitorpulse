import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/connection.js';
import { buildTestApp } from './helpers/app.js';
import { createTestDb } from './helpers/db.js';

describe('health endpoints', () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDb();
    app = await buildTestApp(db);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('reports the process as alive', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });
});
