import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type {
  CatalogEntry,
  Competitor,
  CreateCompetitorRequest,
  Snapshot,
} from '@competitorpulse/shared';
import type { Db } from '../db/connection.js';
import type { SnapshotRow } from '../db/schema.js';
import type { ListingSource } from '../listing-source/http-source.js';
import { sendError } from './errors.js';

export interface CompetitorRoutesOptions {
  db: Db;
  listingSource: ListingSource;
  /** Called when a competitor became due right now, so the poller need not wait a tick. */
  onPollRequested?: () => void;
}

const COMPETITOR_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,62}$';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: COMPETITOR_ID_PATTERN } },
} as const;

function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    fetchedAt: row.fetched_at.toISOString(),
    title: row.title,
    tagline: row.tagline,
    price: row.price,
    description: row.description,
    changed: row.changed,
    changedFields: row.changed_fields,
    summary: row.summary_status === 'done' ? row.summary : null,
    summaryStatus: row.summary_status,
  };
}

export const competitorRoutes: FastifyPluginAsync<CompetitorRoutesOptions> = async (
  app,
  { db, listingSource, onPollRequested },
) => {
  const exists = async (id: string) =>
    (await db.selectFrom('competitors').select('id').where('id', '=', id).executeTakeFirst()) !==
    undefined;

  app.get('/competitors', async (): Promise<Competitor[]> => {
    const rows = await db
      .selectFrom('competitors')
      .select(['id', 'created_at'])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at.toISOString() }));
  });

  // What can be tracked, so the UI can suggest ids instead of making people guess them.
  app.get('/catalog', async (request, reply) => {
    let ids: string[];
    try {
      ids = await listingSource.listCompetitorIds();
    } catch (err) {
      request.log.warn({ err }, 'listing source unavailable while reading catalog');
      return sendError(reply, 503, 'source_unavailable', 'Listing source is unavailable');
    }
    const tracked = new Set(
      (await db.selectFrom('competitors').select('id').execute()).map((r) => r.id),
    );
    const catalog: CatalogEntry[] = [...ids].sort().map((id) => ({ id, tracked: tracked.has(id) }));
    return catalog;
  });

  app.post<{ Body: CreateCompetitorRequest }>(
    '/competitors',
    {
      schema: {
        body: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', pattern: COMPETITOR_ID_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.body;

      if (await exists(id)) {
        return sendError(reply, 409, 'conflict', `${id} is already tracked`);
      }

      let known: boolean;
      try {
        known = (await listingSource.listCompetitorIds()).includes(id);
      } catch (err) {
        request.log.warn({ err }, 'listing source unavailable while adding competitor');
        return sendError(reply, 503, 'source_unavailable', 'Listing source is unavailable');
      }
      if (!known) {
        return sendError(reply, 422, 'unknown_competitor', `The listing source has no ${id}`);
      }

      const created = await db
        .insertInto('competitors')
        .values({ id })
        .onConflict((oc) => oc.column('id').doNothing())
        .returning(['id', 'created_at'])
        .executeTakeFirst();
      if (!created) {
        return sendError(reply, 409, 'conflict', `${id} is already tracked`);
      }

      onPollRequested?.();
      const body: Competitor = { id: created.id, createdAt: created.created_at.toISOString() };
      return reply.code(201).header('location', `/api/competitors/${id}`).send(body);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/competitors/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      const deleted = await db
        .deleteFrom('competitors')
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (deleted.numDeletedRows === 0n) {
        return sendError(reply, 404, 'not_found', `${request.params.id} is not tracked`);
      }
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit: number } }>(
    '/competitors/:id/snapshots',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await exists(id))) {
        return sendError(reply, 404, 'not_found', `${id} is not tracked`);
      }
      const rows = await db
        .selectFrom('snapshots')
        .selectAll()
        .where('competitor_id', '=', id)
        .orderBy('fetched_at', 'desc')
        .orderBy('id', 'desc')
        .limit(request.query.limit)
        .execute();
      return rows.map(toSnapshot);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/competitors/:id/poll',
    { schema: { params: idParams } },
    async (request, reply) => {
      const updated = await db
        .updateTable('competitors')
        .set({ next_poll_at: sql<Date>`now()` })
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) {
        return sendError(reply, 404, 'not_found', `${request.params.id} is not tracked`);
      }
      onPollRequested?.();
      return reply.code(202).send({ id: request.params.id, status: 'queued' });
    },
  );
};
