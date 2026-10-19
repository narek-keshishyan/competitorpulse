import { sql } from 'kysely';
import type { Listing } from '@competitorpulse/shared';
import type { Db } from '../db/connection.js';
import type { SnapshotRow } from '../db/schema.js';
import { diffListings, hashListing, normalizeListing } from './diff.js';

/**
 * Persists one fetched listing and decides whether it changed.
 *
 * Runs in a transaction that locks the competitor row, so two concurrent polls of the
 * same competitor cannot both compare against the same "previous" snapshot. The LLM is
 * deliberately not called here: a changed snapshot is stored as `pending` and the
 * summary worker picks it up, so a slow model never delays or endangers the snapshot.
 *
 * Returns null if the competitor no longer exists (it was removed while we fetched).
 */
export async function recordSnapshot(
  db: Db,
  competitorId: string,
  listing: Listing,
  fetchedAt: Date,
): Promise<SnapshotRow | null> {
  return db.transaction().execute(async (trx) => {
    const competitor = await trx
      .selectFrom('competitors')
      .select('id')
      .where('id', '=', competitorId)
      .forUpdate()
      .executeTakeFirst();
    if (!competitor) return null;

    const previous = await trx
      .selectFrom('snapshots')
      .select(['id', 'title', 'tagline', 'price', 'description'])
      .where('competitor_id', '=', competitorId)
      .orderBy('fetched_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    const normalized = normalizeListing(listing);
    const changedFields = previous ? diffListings(previous, normalized) : [];
    const changed = changedFields.length > 0;

    const snapshot = await trx
      .insertInto('snapshots')
      .values({
        competitor_id: competitorId,
        fetched_at: fetchedAt,
        ...normalized,
        content_hash: hashListing(normalized),
        changed,
        changed_fields: changedFields,
        previous_snapshot_id: previous?.id ?? null,
        summary: null,
        summary_status: changed ? 'pending' : 'not_needed',
        // Database time, like every other scheduling comparison, so app/DB clock skew
        // can't make a fresh job look like it is due in the future.
        summary_next_attempt_at: changed ? sql<Date>`now()` : null,
        summary_error: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('competitors')
      .set({ last_polled_at: fetchedAt, consecutive_failures: 0, last_error: null })
      .where('id', '=', competitorId)
      .execute();

    return snapshot;
  });
}
