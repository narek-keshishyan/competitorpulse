import { createHash } from 'node:crypto';
import { LISTING_FIELDS, type Listing, type ListingField } from '@competitorpulse/shared';

/**
 * Formatting noise (extra spaces, line breaks, different unicode encodings of the same
 * character) must not count as a change: every false positive is a paid LLM call.
 */
export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function normalizeListing(listing: Listing): Listing {
  return {
    title: normalizeText(listing.title),
    tagline: normalizeText(listing.tagline),
    price: normalizeText(listing.price),
    description: normalizeText(listing.description),
  };
}

/** Fields whose normalized value differs, in the canonical field order. */
export function diffListings(previous: Listing, next: Listing): ListingField[] {
  const a = normalizeListing(previous);
  const b = normalizeListing(next);
  return LISTING_FIELDS.filter((field) => a[field] !== b[field]);
}

/** Content fingerprint used to recognise transitions we have already summarised. */
export function hashListing(listing: Listing): string {
  const normalized = normalizeListing(listing);
  const canonical = JSON.stringify(LISTING_FIELDS.map((field) => normalized[field]));
  return createHash('sha256').update(canonical).digest('hex');
}
