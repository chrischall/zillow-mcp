// Token-bucket RPM throttle (issue #90 part b). Total request volume in
// a short window — not concurrency — is what trips PerimeterX, so the
// governor here is requests-per-minute, refilled continuously.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucket, chunk } from '../src/throttle.js';

describe('TokenBucket (per-host RPM throttle)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets the first burst of tokens through without waiting', async () => {
    const bucket = new TokenBucket({ ratePerMinute: 60, burst: 5 });
    // 5 immediate acquisitions should all resolve without advancing time.
    for (let i = 0; i < 5; i++) {
      await bucket.acquire();
    }
    // No assertion on time — if any of these had blocked, the awaits would
    // hang under fake timers and the test would time out.
    expect(true).toBe(true);
  });

  it('blocks the (burst+1)th acquire until a token refills', async () => {
    // 60/min = one token per 1000ms. burst 2 → 2 free, then gated.
    const bucket = new TokenBucket({ ratePerMinute: 60, burst: 2 });
    await bucket.acquire();
    await bucket.acquire();

    let resolved = false;
    const pending = bucket.acquire().then(() => {
      resolved = true;
    });

    // Not yet — bucket is empty.
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Advance ~1s → one token refills → the pending acquire resolves.
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(resolved).toBe(true);
  });

  it('refills proportionally to elapsed time, capped at burst', async () => {
    const bucket = new TokenBucket({ ratePerMinute: 600, burst: 3 }); // 10/s
    // Drain the burst.
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    // Wait far longer than needed to refill — capacity caps at `burst`.
    await vi.advanceTimersByTimeAsync(10_000);
    // Only `burst` tokens are available again, the 4th must wait ~100ms.
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    let resolved = false;
    const pending = bucket.acquire().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(resolved).toBe(true);
  });
});

describe('chunk()', () => {
  it('splits an array into pages of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single page when the input fits', () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it('treats a non-positive size as a single page (defensive)', () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });
});
