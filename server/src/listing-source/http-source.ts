import { z } from 'zod';
import type { Listing } from '@competitorpulse/shared';

/** Where the poller gets the current listing of a competitor from. */
export interface ListingSource {
  fetchListing(id: string): Promise<Listing>;
  /** Every competitor id the source can serve. */
  listCompetitorIds(): Promise<string[]>;
}

export class ListingSourceError extends Error {
  override name = 'ListingSourceError';
}

export class ListingNotFoundError extends ListingSourceError {
  override name = 'ListingNotFoundError';
}

const listingSchema = z.object({
  title: z.string(),
  tagline: z.string(),
  price: z.string(),
  description: z.string(),
});

const catalogSchema = z.object({ ids: z.array(z.string()) });

export interface HttpListingSourceOptions {
  baseUrl: string;
  timeoutMs: number;
}

/** Talks to the listing stub (or anything with the same shape) over HTTP. */
export class HttpListingSource implements ListingSource {
  private readonly baseUrl: string;

  constructor(private readonly options: HttpListingSourceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async fetchListing(id: string): Promise<Listing> {
    const body = await this.getJson(`/listings/${encodeURIComponent(id)}`, id);
    const parsed = listingSchema.safeParse(body);
    if (!parsed.success) {
      throw new ListingSourceError(`Listing for ${id} has an unexpected shape`);
    }
    return parsed.data;
  }

  async listCompetitorIds(): Promise<string[]> {
    const body = await this.getJson('/listings');
    const parsed = catalogSchema.safeParse(body);
    if (!parsed.success) {
      throw new ListingSourceError('Listing catalog has an unexpected shape');
    }
    return parsed.data.ids;
  }

  private async getJson(path: string, competitorId?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new ListingSourceError(`Listing source timed out after ${this.options.timeoutMs}ms`);
      }
      throw new ListingSourceError(`Listing source unreachable: ${(err as Error).message}`);
    }

    if (response.status === 404 && competitorId !== undefined) {
      throw new ListingNotFoundError(`No listing found for ${competitorId}`);
    }
    if (!response.ok) {
      throw new ListingSourceError(`Listing source answered ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new ListingSourceError('Listing source returned invalid JSON');
    }
  }
}
