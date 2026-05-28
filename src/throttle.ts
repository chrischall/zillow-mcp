// Per-host request-rate throttle + small array helpers for bulk fan-out.
//
// Issue #90: ~20 concurrent fetches were fine; ~59 tripped the PerimeterX
// bot-wall. The #78 concurrency cap (6 in flight) governs *parallelism*,
// but the thing PerimeterX actually counts is *total request volume in a
// short window*. So bulk-get needs a second governor on top of the
// concurrency pool: a per-host requests-per-minute token bucket.
//
// Pure-ish: the bucket owns one number (available tokens) and a clock
// reference. No I/O, no logging. Tests drive it with fake timers.

export interface TokenBucketOptions {
  /**
   * Sustained request rate, in requests per minute. The bucket refills
   * continuously at `ratePerMinute / 60_000` tokens per millisecond.
   */
  ratePerMinute: number;
  /**
   * Maximum tokens that can accumulate — i.e. the largest instantaneous
   * burst allowed before the rate limit bites. Defaults to `ratePerMinute`
   * (one minute's worth).
   */
  burst?: number;
}

/**
 * A continuously-refilling token bucket. `acquire()` resolves immediately
 * when a token is available, otherwise waits exactly long enough for the
 * next token to refill. FIFO-ish: callers are served as timers fire.
 *
 * This is the per-host RPM governor for bulk-get (issue #90). One bucket
 * per host (Zillow) is shared across the whole fan-out so that *total*
 * request volume — not just concurrency — stays under the bot-wall
 * threshold.
 */
export class TokenBucket {
  private readonly ratePerMs: number;
  private readonly capacity: number;
  private tokens: number;
  private last: number;

  constructor(opts: TokenBucketOptions) {
    const rate = Math.max(1, opts.ratePerMinute);
    this.ratePerMs = rate / 60_000;
    this.capacity = Math.max(1, opts.burst ?? rate);
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  /** Refill tokens based on elapsed wall-clock time, capped at capacity. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
      this.last = now;
    }
  }

  /**
   * Acquire one token, waiting if the bucket is empty. Resolves as soon
   * as a token is available.
   */
  async acquire(): Promise<void> {
    // Loop rather than single-shot: setTimeout granularity means a wakeup
    // can fire a hair early, leaving us still <1 token; re-check and wait
    // the remainder rather than over-spending.
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil(deficit / this.ratePerMs);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Split `items` into pages of at most `size`. A non-positive `size`
 * collapses to a single page (defensive — never produces an infinite
 * loop). Used by bulk-get to auto-chunk a big id list into safe-sized
 * pages dispatched one after another (issue #90 part c).
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  if (size <= 0) return [items.slice()];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}
