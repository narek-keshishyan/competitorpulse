import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Listing } from '@competitorpulse/shared';

const listingSchema = z.object({
  title: z.string(),
  tagline: z.string(),
  price: z.string(),
  description: z.string(),
});

const fixturesSchema = z.record(z.string(), z.array(listingSchema).min(1));

/**
 * Stand-in for a competitor's public website. Each competitor has a fixed sequence of
 * listing versions; every call returns the next one and the last version repeats once
 * the sequence is exhausted.
 *
 * The counter lives in memory on purpose: this simulates an external site, not our own
 * state. Restarting the process starts every sequence over.
 */
export class ListingStub {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly sequences: Record<string, Listing[]>) {}

  static async fromFile(path: string): Promise<ListingStub> {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return new ListingStub(fixturesSchema.parse(raw));
  }

  ids(): string[] {
    return Object.keys(this.sequences);
  }

  next(id: string): Listing | undefined {
    const sequence = this.sequences[id];
    if (!sequence) return undefined;

    const cursor = this.cursors.get(id) ?? 0;
    const index = Math.min(cursor, sequence.length - 1);
    this.cursors.set(id, Math.min(cursor + 1, sequence.length - 1));
    return sequence[index];
  }

  /** Rewinds one competitor, or all of them, back to the first version. */
  reset(id?: string): void {
    if (id === undefined) this.cursors.clear();
    else this.cursors.delete(id);
  }
}

export interface ListingStubRoutesOptions {
  stub: ListingStub;
}

export const listingStubRoutes: FastifyPluginAsync<ListingStubRoutesOptions> = async (
  app,
  { stub },
) => {
  app.get('/listings', async () => ({ ids: stub.ids() }));

  app.get<{ Params: { id: string } }>('/listings/:id', async (request, reply) => {
    const listing = stub.next(request.params.id);
    if (!listing) {
      return reply
        .code(404)
        .send({ error: 'not_found', message: `No listing for ${request.params.id}` });
    }
    return listing;
  });

  app.post<{ Body: { id?: string } | undefined }>(
    '/reset',
    {
      schema: {
        body: {
          type: 'object',
          nullable: true,
          properties: { id: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      stub.reset(request.body?.id);
      return reply.code(204).send();
    },
  );
};
