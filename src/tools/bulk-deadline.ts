import { withDeadline } from '@chrischall/mcp-utils/fetchproxy';

/**
 * Shared overall-deadline + pending-backfill primitive for the bulk
 * tools (issue #98).
 *
 * The MCP SDK gives each tool call a finite request deadline (commonly
 * 60s). A single hung row with no shorter effective deadline wedges the
 * connection into a `-32001 Request timed out` AND can keep the server
 * busy afterward (the report: a 59-id call hung for the full client
 * timeout, then later small calls hung until restart). Both
 * `zillow_bulk_get` and `zillow_resolve_addresses` need exactly the same
 * shape — a per-input, index-addressable slot array, a bounded fan-out
 * raced against a hard deadline, and a `pending` backfill for any slot
 * the deadline cut off — so it lives here once instead of being copied.
 *
 * Tuned to ~45s in both callers, leaving margin under a 60s client
 * timeout.
 */
export const OVERALL_DEADLINE_MS = 45_000;

/**
 * Run `count` row-fetches into index-addressable slots, bounded by an
 * overall hard deadline.
 *
 * `runFanOut(slots)` must kick off the work and return a single promise
 * that settles when *all* rows have settled (typically a
 * `mapWithConcurrency` over the inputs that writes each result into
 * `slots[index]`). It is raced against `overallDeadlineMs` via
 * `withDeadline`; on expiry the fan-out promise is abandoned (left to
 * settle in the background and ignored) — critically NOT awaited, so a
 * permanently-hung row can't wedge the connection.
 *
 * Any slot still `undefined` after the race is filled by `backfill(index)`
 * — the caller's `pending`-marked row, built from the original input so
 * it stays identifiable and re-runnable. The result is always a
 * full-length, input-ordered array with exactly one row per input.
 */
export async function runWithDeadline<Row>(
  count: number,
  runFanOut: (slots: Array<Row | undefined>) => Promise<unknown>,
  backfill: (index: number) => Row,
  overallDeadlineMs: number = OVERALL_DEADLINE_MS
): Promise<Row[]> {
  const slots: Array<Row | undefined> = Array.from({ length: count });
  await withDeadline(runFanOut(slots), overallDeadlineMs);
  return slots.map((row, index) => row ?? backfill(index));
}
