/**
 * Types shared between the API server and the web client.
 * They describe the public HTTP contract, so changing them is a breaking change.
 */

export interface Competitor {
  id: string;
  createdAt: string;
  /** Scheduler state, so the UI can show when a competitor was and will be checked. */
  lastPolledAt: string | null;
  nextPollAt: string;
  /** Fetch failures since the last successful poll; 0 when healthy. */
  consecutiveFailures: number;
  lastError: string | null;
}

export interface Listing {
  title: string;
  tagline: string;
  price: string;
  description: string;
}

export type ListingField = keyof Listing;

export const LISTING_FIELDS: readonly ListingField[] = ['title', 'tagline', 'price', 'description'];

/**
 * - `not_needed`: first snapshot, or nothing changed since the previous one.
 * - `pending`: a change was detected and the summary has not been generated yet.
 * - `done`: `summary` holds the generated text.
 * - `failed`: generation gave up after the configured number of attempts.
 */
export type SummaryStatus = 'not_needed' | 'pending' | 'done' | 'failed';

export interface Snapshot extends Listing {
  id: number;
  fetchedAt: string;
  changed: boolean;
  changedFields: ListingField[];
  summary: string | null;
  summaryStatus: SummaryStatus;
}

/** A competitor the listing source knows about, i.e. one that can be tracked. */
export interface CatalogEntry {
  id: string;
  tracked: boolean;
}

export interface CreateCompetitorRequest {
  id: string;
}

export interface PollRequestAccepted {
  id: string;
  status: 'queued';
  /** Seconds until another "Poll now" for this competitor will be accepted. */
  retryAfterSeconds: number;
}

export interface ApiError {
  error: string;
  message: string;
  /** Set on 429 responses: how long to wait before trying again. */
  retryAfterSeconds?: number;
}
