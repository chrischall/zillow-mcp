// Exponential-backoff-with-jitter delay computation (issue #90 part b).
//
// On a `rate_limited_captcha` outcome bulk-get backs off and retries the
// blocked sub-requests rather than failing them. The schedule is full
// jitter (AWS-style): a uniform random pick in [0, exponential-window],
// which decorrelates concurrent retriers so they don't re-stampede the
// bot-wall in lockstep.
//
// Pure: the random source is injected so callers (and tests) can make
// the schedule deterministic.

export interface BackoffOptions {
  /** Base delay (ms) for attempt 0. The exponential window is base*2^attempt. */
  baseMs: number;
  /** Hard ceiling (ms) on the exponential window before jitter. */
  capMs: number;
  /** Random source in [0,1). Defaults to `Math.random`. */
  rng?: () => number;
  /**
   * Lower bound (ms) on the returned delay — used to honour a server /
   * captcha `retry-after` hint so jitter can't undershoot it.
   */
  floorMs?: number;
}

/**
 * Delay (ms) before the given retry `attempt` (0-based). Full-jitter:
 * `rng() * min(capMs, baseMs * 2^attempt)`, then floored at `floorMs`.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions): number {
  const rng = opts.rng ?? Math.random;
  const window = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
  const jittered = rng() * window;
  const floor = opts.floorMs ?? 0;
  return Math.max(floor, Math.round(jittered));
}

/** Promise-based sleep. Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
