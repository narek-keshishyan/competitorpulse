/**
 * Types shared between the API server and the web client.
 * They describe the public HTTP contract, so changing them is a breaking change.
 */

export interface Competitor {
  id: string;
  createdAt: string;
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

export interface CreateCompetitorRequest {
  id: string;
}

export interface ApiError {
  error: string;
  message: string;
}
