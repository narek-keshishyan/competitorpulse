import { describe, expect, it } from 'vitest';
import type { Listing } from '@competitorpulse/shared';
import { diffListings, hashListing, normalizeListing } from '../src/polling/diff.js';

const base: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$39/mo',
  description: 'Track leads and deals in one place.',
};

describe('normalizeListing', () => {
  it('trims and collapses whitespace in every field', () => {
    expect(
      normalizeListing({
        title: '  Acme   CRM ',
        tagline: 'Simple\nCRM\tfor small teams',
        price: ' $39/mo',
        description: 'Track leads and deals in one place.  ',
      }),
    ).toEqual(base);
  });

  it('unifies equivalent unicode representations', () => {
    const composed = normalizeListing({ ...base, title: 'Café' });
    const decomposed = normalizeListing({ ...base, title: 'Café' });

    expect(composed.title).toBe(decomposed.title);
  });
});

describe('diffListings', () => {
  it('returns no fields for identical listings', () => {
    expect(diffListings(base, { ...base })).toEqual([]);
  });

  it('ignores whitespace-only differences', () => {
    expect(diffListings(base, { ...base, tagline: ' Simple  CRM for small teams ' })).toEqual([]);
  });

  it('lists every changed field in a stable order', () => {
    const next = { ...base, description: 'New', price: '$29/mo' };

    expect(diffListings(base, next)).toEqual(['price', 'description']);
  });

  it('treats case changes as real changes', () => {
    expect(diffListings(base, { ...base, title: 'ACME CRM' })).toEqual(['title']);
  });
});

describe('hashListing', () => {
  it('is equal for listings that only differ in whitespace', () => {
    expect(hashListing(base)).toBe(hashListing({ ...base, title: ' Acme  CRM' }));
  });

  it('differs when any field changes', () => {
    expect(hashListing(base)).not.toBe(hashListing({ ...base, price: '$29/mo' }));
  });

  it('cannot be fooled by moving text between fields', () => {
    const a = { ...base, title: 'ab', tagline: 'c' };
    const b = { ...base, title: 'a', tagline: 'bc' };

    expect(hashListing(a)).not.toBe(hashListing(b));
  });
});
