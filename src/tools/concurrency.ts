/**
 * Bulk-tool fan-out helpers (issue #78).
 *
 * `zillow_resolve_addresses` and `zillow_bulk_get` used to launch every
 * sub-request at once with `Promise.all(...)`. A real-world session
 * timed out 7 of 20 sub-requests inside the bridge's default 30s window
 * — a 35% miss rate. Redfin's bulk resolver ran the same 20 with zero
 * timeouts at a much lower in-flight cap.
 *
 * `mapWithConcurrency` paces the fan-out to a Redfin-style cap, and
 * `retryOnceOnTimeout` retries each individual sub-request once after a
 * transient `FetchproxyTimeoutError` so a single bridge hiccup doesn't
 * surface as a `resolved: false` (which the caller would otherwise
 * record as "no listing found" — exactly what the reporter warned about).
 */

import { FetchproxyTimeoutError } from '../transport-fetchproxy.js';

/**
 * In-flight cap shared by every bulk tool. Tuned to match Redfin's
 * concurrency profile (~6) — the same 20-address batch that produced 7
 * timeouts at unlimited concurrency lands clean at 6.
 */
export const BULK_CONCURRENCY = 6;

/**
 * Run `fn` over every entry in `items`, keeping at most `limit`
 * promises in flight at a time. Output order matches input order
 * regardless of completion order (so per-row tools can splice errors
 * inline without re-sorting).
 *
 * `fn` is responsible for its own error capture — this helper does NOT
 * swallow rejections. Throwing rejects the whole `mapWithConcurrency`
 * call. The bulk tools wrap each task in try/catch so this never fires
 * in practice; library callers can do the same.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return out;
}

/**
 * Retry `fn` exactly once if the first call throws
 * `FetchproxyTimeoutError`. Any other error class (HTTP 5xx, parse
 * failure, generic Error) propagates immediately — only the transient-
 * SW-eviction case where the bridge silently dropped the request gets a
 * second chance.
 *
 * Use this around an *individual* sub-request inside a bulk handler so
 * one transient hiccup doesn't fail a single row, while a genuine
 * upstream miss still produces the right `resolved: false`.
 */
export async function retryOnceOnTimeout<R>(
  fn: () => Promise<R>
): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof FetchproxyTimeoutError) {
      return await fn();
    }
    throw err;
  }
}
