import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type {
  ApiError,
  CatalogEntry,
  Competitor,
  CreateCompetitorRequest,
  Snapshot,
  TimelineEntry,
} from '@competitorpulse/shared';
import type { Db } from '../db/connection.js';
import type { CompetitorRow, SnapshotRow } from '../db/schema.js';
import type { ListingSource } from '../listing-source/http-source.js';
import { sendError } from './errors.js';

export interface CompetitorRoutesOptions {
  db: Db;
  listingSource: ListingSource;
  /** Called when a competitor became due right now, so the poller need not wait a tick. */
  onPollRequested?: () => void;
  /** Minimum seconds between two accepted "Poll now" requests per competitor. */
  manualPollCooldownSeconds: number;
  /** Stricter per-client limit for endpoints that change data (needs the rate limiter). */
  writesPerMinute?: number;
}

const COMPETITOR_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,62}$';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: COMPETITOR_ID_PATTERN } },
} as const;

function toCompetitor(row: CompetitorRow): Competitor {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    lastPolledAt: row.last_polled_at?.toISOString() ?? null,
    nextPollAt: row.next_poll_at.toISOString(),
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
  };
}

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
  { db, listingSource, onPollRequested, manualPollCooldownSeconds, writesPerMinute },
) => {
  const writeLimit = writesPerMinute
    ? { rateLimit: { max: writesPerMinute, timeWindow: '1 minute' } }
    : {};

  const cooldown = sql<Date>`make_interval(secs => ${manualPollCooldownSeconds}::float8)`;

  const exists = async (id: string) =>
    (await db.selectFrom('competitors').select('id').where('id', '=', id).executeTakeFirst()) !==
    undefined;

  app.get('/competitors', async (): Promise<Competitor[]> => {
    const rows = await db
      .selectFrom('competitors')
      .selectAll()
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toCompetitor);
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
      config: writeLimit,
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
        .returningAll()
        .executeTakeFirst();
      if (!created) {
        return sendError(reply, 409, 'conflict', `${id} is already tracked`);
      }

      onPollRequested?.();
      return reply
        .code(201)
        .header('location', `/api/competitors/${id}`)
        .send(toCompetitor(created));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/competitors/:id',
    { config: writeLimit, schema: { params: idParams } },
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

  app.get<{ Params: { id: string }; Querystring: { limit: number } }>(
    '/competitors/:id/timeline',
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
      // "Gaps and islands": a running count of changed snapshots numbers the groups, so
      // every change starts a new group (the first snapshot starts group 0) and the
      // unchanged checks that follow it fall into the same group.
      const { rows } = await sql<SnapshotRow & { unchanged_checks: number; last_checked_at: Date }>`
        with numbered as (
          select id, fetched_at,
                 count(*) filter (where changed) over (order by fetched_at, id) as grp
          from snapshots
          where competitor_id = ${id}
        ),
        groups as (
          select (array_agg(id order by fetched_at, id))[1] as head_id,
                 count(*)::int - 1 as unchanged_checks,
                 max(fetched_at) as last_checked_at
          from numbered
          group by grp
        )
        select s.*, g.unchanged_checks, g.last_checked_at
        from groups g
        join snapshots s on s.id = g.head_id
        order by s.fetched_at desc, s.id desc
        limit ${request.query.limit}
      `.execute(db);
      return rows.map((row): TimelineEntry => ({
        snapshot: toSnapshot(row),
        unchangedChecks: row.unchanged_checks,
        lastCheckedAt: row.last_checked_at.toISOString(),
      }));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/competitors/:id/poll',
    { config: writeLimit, schema: { params: idParams } },
    async (request, reply) => {
      const { id } = request.params;
      // Check and claim in one statement: concurrent requests are serialized on the row, so
      // exactly one per cooldown window gets through, across all clients and instances.
      // Without this, a loop of requests would make the poller write a snapshot per run.
      const accepted = await db
        .updateTable('competitors')
        .set({ next_poll_at: sql<Date>`now()`, last_manual_poll_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where((eb) =>
          eb.or([
            eb('last_manual_poll_at', 'is', null),
            eb('last_manual_poll_at', '<=', sql<Date>`now() - ${cooldown}`),
          ]),
        )
        .executeTakeFirst();

      if (accepted.numUpdatedRows === 0n) {
        const row = await db
          .selectFrom('competitors')
          .select(
            sql<number>`ceil(extract(epoch from last_manual_poll_at + ${cooldown} - now()))::int`.as(
              'retry_after',
            ),
          )
          .where('id', '=', id)
          .executeTakeFirst();
        if (!row) {
          return sendError(reply, 404, 'not_found', `${id} is not tracked`);
        }
        const retryAfterSeconds = Math.max(1, row.retry_after);
        const body: ApiError = {
          error: 'too_many_requests',
          message: `${id} was just polled; try again in ${retryAfterSeconds}s`,
          retryAfterSeconds,
        };
        return reply.code(429).header('retry-after', String(retryAfterSeconds)).send(body);
      }

      onPollRequested?.();
      // Tells the client how long until it may ask again, so it can show a countdown.
      return reply
        .code(202)
        .send({ id, status: 'queued', retryAfterSeconds: manualPollCooldownSeconds });
    },
  );
};
