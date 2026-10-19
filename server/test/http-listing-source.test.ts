import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  HttpListingSource,
  ListingNotFoundError,
  ListingSourceError,
} from '../src/listing-source/http-source.js';
import { ListingStub, listingStubRoutes } from '../src/listing-source/stub.js';

const listing = { title: 'T', tagline: 'tag', price: '$1', description: 'd' };

describe('HttpListingSource', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(listingStubRoutes, {
      prefix: '/stub',
      stub: new ListingStub({ acme: [listing] }),
    });
    app.get('/broken/listings/:id', async () => ({ title: 'missing fields' }));
    app.get('/slow/listings/:id', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return listing;
    });
    app.get('/down/listings/:id', async (_req, reply) => reply.code(503).send());
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
  });

  const source = (path: string, timeoutMs = 1_000) =>
    new HttpListingSource({ baseUrl: `${baseUrl}${path}`, timeoutMs });

  it('fetches and validates a listing', async () => {
    await expect(source('/stub').fetchListing('acme')).resolves.toEqual(listing);
  });

  it('reports which competitors exist', async () => {
    await expect(source('/stub').hasCompetitor('acme')).resolves.toBe(true);
    await expect(source('/stub').hasCompetitor('nope')).resolves.toBe(false);
  });

  it('raises ListingNotFoundError on 404', async () => {
    await expect(source('/stub').fetchListing('nope')).rejects.toBeInstanceOf(ListingNotFoundError);
  });

  it('raises ListingSourceError on server errors', async () => {
    await expect(source('/down').fetchListing('acme')).rejects.toThrow(/503/);
  });

  it('raises ListingSourceError when the payload does not look like a listing', async () => {
    await expect(source('/broken').fetchListing('acme')).rejects.toBeInstanceOf(ListingSourceError);
  });

  it('gives up after the timeout', async () => {
    await expect(source('/slow', 50).fetchListing('acme')).rejects.toThrow(/timed out/);
  });

  it('url-encodes the competitor id', async () => {
    await expect(source('/stub').fetchListing('../listings')).rejects.toBeInstanceOf(
      ListingNotFoundError,
    );
  });
});
