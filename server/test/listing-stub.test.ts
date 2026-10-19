import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Listing } from '@competitorpulse/shared';
import { ListingStub, listingStubRoutes } from '../src/listing-source/stub.js';

const v = (price: string): Listing => ({ title: 'T', tagline: 'tag', price, description: 'd' });

describe('ListingStub', () => {
  it('returns the next version on every call and repeats the last one', () => {
    const stub = new ListingStub({ acme: [v('1'), v('2'), v('3')] });

    expect([1, 2, 3, 4, 5].map(() => stub.next('acme')?.price)).toEqual(['1', '2', '3', '3', '3']);
  });

  it('keeps an independent counter per competitor', () => {
    const stub = new ListingStub({ a: [v('a1'), v('a2')], b: [v('b1'), v('b2')] });

    stub.next('a');
    stub.next('a');

    expect(stub.next('b')?.price).toBe('b1');
  });

  it('returns undefined for an unknown competitor', () => {
    expect(new ListingStub({}).next('nope')).toBeUndefined();
  });

  it('can rewind one competitor or all of them', () => {
    const stub = new ListingStub({ a: [v('a1'), v('a2')], b: [v('b1'), v('b2')] });
    stub.next('a');
    stub.next('b');

    stub.reset('a');
    expect(stub.next('a')?.price).toBe('a1');
    expect(stub.next('b')?.price).toBe('b2');

    stub.reset();
    expect(stub.next('b')?.price).toBe('b1');
  });

  it('loads the provided fixtures', async () => {
    const stub = await ListingStub.fromFile(
      new URL('../fixtures/listings.json', import.meta.url).pathname,
    );

    expect(stub.ids()).toEqual(['acme-crm', 'north-analytics', 'ferry-pay']);
    expect(stub.next('acme-crm')).toEqual({
      title: 'Acme CRM',
      tagline: 'Simple CRM for small teams',
      price: '$29/mo',
      description: 'Track leads and deals in one place.',
    });
  });
});

describe('listing stub routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(listingStubRoutes, {
      prefix: '/stub',
      stub: new ListingStub({ acme: [v('1'), v('2')] }),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the known competitor ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/stub/listings' });

    expect(res.json()).toEqual({ ids: ['acme'] });
  });

  it('serves the sequence over HTTP', async () => {
    const first = await app.inject({ method: 'GET', url: '/stub/listings/acme' });
    const second = await app.inject({ method: 'GET', url: '/stub/listings/acme' });

    expect(first.json().price).toBe('1');
    expect(second.json().price).toBe('2');
  });

  it('answers 404 for an unknown competitor', async () => {
    const res = await app.inject({ method: 'GET', url: '/stub/listings/nope' });

    expect(res.statusCode).toBe(404);
  });

  it('rewinds through the reset endpoint', async () => {
    const reset = await app.inject({ method: 'POST', url: '/stub/reset', payload: { id: 'acme' } });
    const next = await app.inject({ method: 'GET', url: '/stub/listings/acme' });

    expect(reset.statusCode).toBe(204);
    expect(next.json().price).toBe('1');
  });
});
