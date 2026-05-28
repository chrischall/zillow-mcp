import { describe, it, expect, vi } from 'vitest';
import {
  BULK_CONCURRENCY,
  mapWithConcurrency,
  retryOnceOnTimeout,
} from '../../src/tools/concurrency.js';
import { FetchproxyTimeoutError } from '../../src/transport-fetchproxy.js';

describe('mapWithConcurrency (issue #78)', () => {
  it('runs at most `limit` jobs in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const work = async (n: number): Promise<number> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield so concurrent peers can ramp up.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    };
    const input = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapWithConcurrency(input, 6, work);
    expect(out).toEqual(input.map((n) => n * 2));
    // Peak strictly bounded by `limit`.
    expect(peak).toBeLessThanOrEqual(6);
    // Sanity: a 20-job batch should actually saturate the limit at least once.
    expect(peak).toBeGreaterThan(1);
  });

  it('preserves input order in the output (despite out-of-order completion)', async () => {
    const out = await mapWithConcurrency(
      [100, 10, 1],
      2,
      async (ms: number): Promise<number> => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      }
    );
    expect(out).toEqual([100, 10, 1]);
  });

  it('does not short-circuit on a thrown sub-task — the wrapping handler is the caller', async () => {
    // Use-case: bulk tools wrap each task in per-row try/catch and want
    // mapWithConcurrency to schedule every row regardless. Verify by
    // wrapping in the same way the bulk tool does and confirming all
    // rows return (some with `error`, some with `ok`).
    const rows = await mapWithConcurrency(
      [1, 2, 3, 4],
      2,
      async (n: number): Promise<{ n: number; err?: string }> => {
        try {
          if (n === 2) throw new Error('boom');
          return { n };
        } catch (e) {
          return { n, err: (e as Error).message };
        }
      }
    );
    expect(rows).toHaveLength(4);
    expect(rows[1].err).toBe('boom');
    expect(rows[3].err).toBeUndefined();
  });

  it('exports BULK_CONCURRENCY = 6 (Redfin parity)', () => {
    // Pin the cap. Real-world reporter: Zillow fanned all 20 at once
    // and timed out 7 of them; Redfin ran the same 20 with zero
    // timeouts at ~6 in flight.
    expect(BULK_CONCURRENCY).toBe(6);
  });
});

describe('retryOnceOnTimeout (issue #78)', () => {
  it('returns the result of the underlying call on success', async () => {
    const fn = vi.fn(async () => 42);
    await expect(retryOnceOnTimeout(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once when the underlying call throws FetchproxyTimeoutError', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new FetchproxyTimeoutError({ url: '/x', timeoutMs: 30_000 });
      return 'second-try';
    };
    await expect(retryOnceOnTimeout(fn)).resolves.toBe('second-try');
    expect(calls).toBe(2);
  });

  it('rethrows after a second timeout (does not retry again)', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new FetchproxyTimeoutError({ url: '/x', timeoutMs: 30_000 });
    };
    await expect(retryOnceOnTimeout(fn)).rejects.toBeInstanceOf(
      FetchproxyTimeoutError
    );
    expect(calls).toBe(2);
  });

  it('does NOT retry non-timeout errors (a 502, parse error, etc.)', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error('upstream 502');
    };
    await expect(retryOnceOnTimeout(fn)).rejects.toThrow(/upstream 502/);
    expect(calls).toBe(1);
  });
});
