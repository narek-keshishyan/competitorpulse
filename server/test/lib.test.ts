import { describe, expect, it, vi } from 'vitest';
import { backoffMs } from '../src/lib/backoff.js';
import { mapWithConcurrency } from '../src/lib/concurrency.js';
import { startLoop } from '../src/lib/loop.js';

const silentLog = { error: () => {} };

describe('backoffMs', () => {
  const opts = { baseMs: 1_000, maxMs: 10_000, random: () => 1 };

  it('doubles with every attempt', () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, opts))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('never exceeds the cap', () => {
    expect(backoffMs(20, opts)).toBe(10_000);
  });

  it('spreads retries between half and the full delay', () => {
    expect(backoffMs(3, { ...opts, random: () => 0 })).toBe(2_000);
  });
});

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once and keeps result order', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 10, 20, 5, 15], 2, async (ms) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return ms * 2;
    });

    expect(peak).toBe(2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([
      60, 20, 40, 10, 30,
    ]);
  });

  it('isolates failures to the item that failed', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('nope');
      return n;
    });

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('startLoop', () => {
  it('runs immediately and then after each interval', async () => {
    const run = vi.fn(async () => {});
    const loop = startLoop({ name: 'test', intervalMs: 20, run, log: silentLog });

    await new Promise((resolve) => setTimeout(resolve, 70));
    await loop.stop();

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('never overlaps runs', async () => {
    let running = 0;
    let overlapped = false;
    const loop = startLoop({
      name: 'test',
      intervalMs: 1,
      log: silentLog,
      run: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 15));
        running -= 1;
      },
    });
    loop.wake();
    loop.wake();

    await new Promise((resolve) => setTimeout(resolve, 60));
    await loop.stop();

    expect(overlapped).toBe(false);
  });

  it('keeps going after a run throws', async () => {
    const error = vi.fn();
    let calls = 0;
    const loop = startLoop({
      name: 'test',
      intervalMs: 5,
      log: { error },
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    await loop.stop();

    expect(error).toHaveBeenCalledOnce();
    expect(calls).toBeGreaterThan(1);
  });

  it('wake() runs without waiting for the interval', async () => {
    const run = vi.fn(async () => {});
    const loop = startLoop({ name: 'test', intervalMs: 60_000, run, log: silentLog });
    await new Promise((resolve) => setTimeout(resolve, 10));

    loop.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await loop.stop();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stop() waits for the run in progress', async () => {
    let finished = false;
    const loop = startLoop({
      name: 'test',
      intervalMs: 1_000,
      log: silentLog,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        finished = true;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await loop.stop();

    expect(finished).toBe(true);
  });
});
