import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/connection.js';
import { fakeListingSource } from './helpers/app.js';
import { createTestDb } from './helpers/db.js';

describe('serving the web app', () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'web-dist-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>CompetitorPulse</title>');
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
    db = await createTestDb();
    app = await buildApp({ db, listingSource: fakeListingSource(), webDistDir: dir });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('serves built assets', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/competitors/acme-crm' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('CompetitorPulse');
  });

  it('keeps JSON 404s for unknown API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});
