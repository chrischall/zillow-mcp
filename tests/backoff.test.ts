// Exponential-backoff-with-jitter delay computation (issue #90 part b).
// Pure function — the random source is injected so the schedule is
// deterministic under test.
import { describe, it, expect } from 'vitest';
import { backoffDelayMs } from '../src/backoff.js';

describe('backoffDelayMs', () => {
  const base = 1000;
  const cap = 30_000;

  it('grows exponentially with the attempt number (rng=1 → full window)', () => {
    // With rng() === 1 the jittered delay equals the full exponential
    // window: base * 2^attempt.
    expect(backoffDelayMs(0, { baseMs: base, capMs: cap, rng: () => 1 })).toBe(
      1000
    );
    expect(backoffDelayMs(1, { baseMs: base, capMs: cap, rng: () => 1 })).toBe(
      2000
    );
    expect(backoffDelayMs(2, { baseMs: base, capMs: cap, rng: () => 1 })).toBe(
      4000
    );
  });

  it('is capped at capMs no matter how high the attempt', () => {
    expect(
      backoffDelayMs(20, { baseMs: base, capMs: cap, rng: () => 1 })
    ).toBe(cap);
  });

  it('applies full jitter — rng=0 collapses the delay toward zero', () => {
    expect(backoffDelayMs(3, { baseMs: base, capMs: cap, rng: () => 0 })).toBe(
      0
    );
  });

  it('jitter scales the window — rng=0.5 yields half the exponential window', () => {
    // attempt 2 → window 4000; rng 0.5 → 2000.
    expect(
      backoffDelayMs(2, { baseMs: base, capMs: cap, rng: () => 0.5 })
    ).toBe(2000);
  });

  it('honours a retry-after floor when supplied (server hint wins)', () => {
    // The captcha says wait 30s; even with rng=0 the delay never drops
    // below the floor.
    expect(
      backoffDelayMs(0, {
        baseMs: base,
        capMs: cap,
        rng: () => 0,
        floorMs: 30_000,
      })
    ).toBe(30_000);
  });
});
