import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Db } from '../../src/db/connection.js';
import type { ListingSource } from '../../src/listing-source/http-source.js';

export const knownIds = ['acme-crm', 'north-analytics', 'ferry-pay'];

export function fakeListingSource(): ListingSource {
  return {
    fetchListing: vi.fn(async () => ({ title: 't', tagline: 't', price: 'p', description: 'd' })),
    listCompetitorIds: vi.fn(async () => knownIds),
  };
}

export async function buildTestApp(
  db: Db,
  overrides: { listingSource?: ListingSource; onPollRequested?: () => void } = {},
): Promise<FastifyInstance> {
  return buildApp({
    db,
    listingSource: overrides.listingSource ?? fakeListingSource(),
    onPollRequested: overrides.onPollRequested,
  });
}
