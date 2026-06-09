import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  TokenBucket,
  backoffDelayMs,
  chunk,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
  sleep,
  withDeadline,
} from '@chrischall/mcp-utils/fetchproxy';
import { BotWallError, type ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  fetchPropertyRecord,
  format,
  type FormattedProperty,
} from './properties.js';

// `chunk` (auto-chunking a big id list into safe-sized pages, issue #90
// part c) and `sleep` come from the shared resilience kit. Re-exported
// so existing importers/tests keep their `bulk-get.js` import surface.
export { chunk };

/**
 * `zillow_bulk_get`: structured fetch of N properties in one call.
 *
 * Sibling to `zillow_compare_properties` but with a higher cap and no
 * pivoted summary table — this is the "give me everything for these 50
 * saved homes" endpoint, not the analysis endpoint. A 53-listing
 * session can fetch in 1 round trip instead of 7 sequential 8-at-a-time
 * compare calls. (Issue #46.)
 *
 * Errors for individual zpids are captured per-row so a single bad zpid
 * doesn't fail the whole batch.
 *
 * Issue #90 hardening — PerimeterX bot-wall (0.10.0: resilience kit):
 *   - a px-captcha 403 is classified as `bot_challenge` (the kit's
 *     canonical kind), a distinct value that NEVER masquerades as
 *     not-found / generic error;
 *   - a per-host requests-per-minute token bucket (the kit's
 *     `TokenBucket`) governs *total* request volume (not just
 *     concurrency — that's what trips px);
 *   - blocked sub-requests back off (exponential + jitter) and retry
 *     rather than failing outright;
 *   - the big id list is auto-chunked into safe-sized pages dispatched
 *     one after another;
 *   - a partial-result envelope `{ blocked, retry_after_s }` lets the
 *     caller finish anything still walled in a second pass.
 */

/**
 * Upper bound on `zpids[]` / `urls[]`. 200 covers the realistic
 * "give me everything" case while keeping a single bulk_get call
 * cheap enough to fan out concurrently without slamming Zillow.
 */
export const BULK_GET_MAX = 200;

/**
 * Safe internal page size. Empirically (issue #90) ~20 ids cleared the
 * PerimeterX wall while ~59 in one shot tripped it. bulk_get advertises
 * up to 200, so a 200-id call is auto-chunked into pages of this size,
 * dispatched sequentially with the RPM throttle pacing the requests
 * inside each page.
 */
export const BULK_GET_CHUNK_SIZE = 20;

/**
 * Per-host sustained request rate for Zillow, requests per minute. The
 * governor that keeps *total* volume under the bot-wall threshold
 * (issue #90 part b). Conservative: ~one request every ~0.4s sustained,
 * with a short burst allowance for the first page.
 */
const ZILLOW_RPM = 150;
/** Burst allowance — one safe page worth of immediate tokens. */
const ZILLOW_BURST = BULK_GET_CHUNK_SIZE;

/** Backoff schedule on a captcha block. */
const CAPTCHA_BACKOFF_BASE_MS = 1_000;
const CAPTCHA_BACKOFF_CAP_MS = 30_000;
/** How many times a captcha-blocked sub-request is retried before giving up. */
const CAPTCHA_MAX_RETRIES = 3;

/**
 * Overall hard deadline (ms) for the whole `bulk_get` call (issue #98).
 * The MCP SDK gives each tool call a finite request deadline (commonly
 * 60s); a single hung row with no shorter effective deadline wedges the
 * connection into a `-32001 Request timed out` AND can keep the server
 * busy afterward (the report: a 59-id call hung for the full client
 * timeout, then later small calls hung until restart). We cap the whole
 * batch comfortably below that so a slow/hanging row turns into a
 * `pending`-marked partial result instead of a wedge. Tuned to ~45s,
 * leaving margin under a 60s client timeout.
 */
const OVERALL_DEADLINE_MS = 45_000;

/**
 * Tuning knobs for the throttle/backoff machinery. Defaults are the
 * production values above; tests inject tiny values so the suite doesn't
 * wait on real wall-clock delays.
 */
export interface BulkGetTuning {
  ratePerMinute?: number;
  burst?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  chunkSize?: number;
  maxCaptchaRetries?: number;
  /**
   * Overall hard deadline (ms) for the whole call (issue #98). When it
   * fires, any row that hasn't settled is returned with
   * `error_kind: 'pending'` and the call resolves with partial results
   * rather than hanging. Defaults to {@link OVERALL_DEADLINE_MS}.
   */
  overallDeadlineMs?: number;
  /** Random source for backoff jitter (defaults to Math.random). */
  rng?: () => number;
}

interface BulkGetRow {
  zpid: string;
  property?: FormattedProperty;
  error?: string;
  /**
   * Issue #90: machine-readable error classification so callers can
   * branch without string-matching. Present only on error rows. The
   * critical value is `bot_challenge` (the resilience kit's canonical
   * bot-wall {@link FetchErrorKind}, 0.10.0) — distinct from a generic
   * `error`/not-found so a bot-wall is never mistaken for a gone listing.
   */
  error_kind?:
    | 'bot_challenge'
    | 'timeout'
    | 'bridge_down'
    | 'protocol'
    | 'pending'
    | 'other';
}

type Target = { zpid?: number | string; url?: string };

/**
 * Fetch one target, with the #78 timeout retry AND the #90 bot-wall
 * backoff retry layered on. Returns a per-row envelope; never throws.
 *
 * On a bot-wall block we back off (full jitter, floored at the wall's
 * own retry-after hint) and retry up to `maxCaptchaRetries`. If it never
 * clears, the row is returned with `error_kind: 'bot_challenge'` and the
 * wall's retry-after seconds so the caller can finish it in a second
 * pass — it is NEVER downgraded to a generic miss.
 */
async function fetchOneRow(
  client: ZillowClient,
  bucket: TokenBucket,
  target: Target,
  cfg: Required<Omit<BulkGetTuning, 'rng'>> & { rng: () => number },
  blockedRetryAfter: { seconds: number }
): Promise<BulkGetRow> {
  const fallbackZpid = 'zpid' in target ? String(target.zpid) : '';
  let lastBotWall: BotWallError | null = null;

  for (let attempt = 0; attempt <= cfg.maxCaptchaRetries; attempt++) {
    // Spend a token before every attempt — the throttle paces total
    // request volume across the whole fan-out.
    await bucket.acquire();
    try {
      const { raw } = await retryOnceOnTimeout(() =>
        fetchPropertyRecord(client, target)
      );
      return {
        zpid: String(raw.zpid ?? fallbackZpid),
        property: format(raw),
      };
    } catch (e) {
      if (e instanceof BotWallError) {
        lastBotWall = e;
        if (attempt < cfg.maxCaptchaRetries) {
          // Honour the wall's retry-after hint as a floor, but never wait
          // longer than the backoff cap on a single in-batch retry — a
          // 30s server hint shouldn't stall the whole batch. Anything
          // still blocked after the bounded retries is reported in the
          // partial-result envelope with the *full* retry-after for a
          // second pass.
          const retryAfterMs = Math.min(
            e.retryAfterSeconds * 1_000,
            cfg.backoffCapMs
          );
          const delay = backoffDelayMs(attempt, {
            baseMs: cfg.backoffBaseMs,
            capMs: cfg.backoffCapMs,
            rng: cfg.rng,
            retryAfterMs,
          });
          await sleep(delay);
          continue;
        }
        // Retries exhausted — surface the block, distinctly.
        blockedRetryAfter.seconds = Math.max(
          blockedRetryAfter.seconds,
          e.retryAfterSeconds
        );
        return {
          zpid: fallbackZpid,
          error: e.message,
          error_kind: 'bot_challenge',
        };
      }
      // Non-bot-wall failure: classify with the cohort helper (timeout /
      // bridge_down / protocol / other) and stop — these are not the
      // bot-wall, so backoff-retry doesn't apply.
      const classified = classifyRowError(e);
      return {
        zpid: fallbackZpid,
        error: classified.message,
        error_kind: classified.kind,
      };
    }
  }
  // Unreachable in practice (loop always returns), but keeps the
  // type-checker happy and is defensive if maxCaptchaRetries < 0.
  blockedRetryAfter.seconds = Math.max(
    blockedRetryAfter.seconds,
    lastBotWall?.retryAfterSeconds ?? 0
  );
  return {
    zpid: fallbackZpid,
    error: lastBotWall?.message ?? 'unknown bulk-get failure',
    error_kind: lastBotWall ? 'bot_challenge' : 'other',
  };
}

export function registerBulkGetTools(
  server: McpServer,
  client: ZillowClient,
  tuning: BulkGetTuning = {}
): void {
  const cfg = {
    ratePerMinute: tuning.ratePerMinute ?? ZILLOW_RPM,
    burst: tuning.burst ?? ZILLOW_BURST,
    backoffBaseMs: tuning.backoffBaseMs ?? CAPTCHA_BACKOFF_BASE_MS,
    backoffCapMs: tuning.backoffCapMs ?? CAPTCHA_BACKOFF_CAP_MS,
    chunkSize: tuning.chunkSize ?? BULK_GET_CHUNK_SIZE,
    maxCaptchaRetries: tuning.maxCaptchaRetries ?? CAPTCHA_MAX_RETRIES,
    overallDeadlineMs: tuning.overallDeadlineMs ?? OVERALL_DEADLINE_MS,
    rng: tuning.rng ?? Math.random,
  };

  server.registerTool(
    'zillow_bulk_get',
    {
      title: 'Bulk-fetch Zillow properties by zpid',
      description:
        `Fetch up to ${BULK_GET_MAX} Zillow property records in a single call — the "give me everything for these N saved homes" endpoint. Returns one structured row per input id ` +
        '(no pivoted side-by-side summary table — for 2-25 listings with a comparison summary use `zillow_compare_properties`). Each row is either ' +
        '`{ zpid, property }` on success or `{ zpid, error, error_kind }` on failure — one bad zpid never fails the ' +
        `whole call. Calls fan out concurrently against \`/homedetails/<zpid>_zpid/\` (capped at 6 in flight, per issue #78, with retry-once-on-timeout per sub-request to absorb transient SW evictions). ` +
        `Big lists are auto-chunked into pages of ${BULK_GET_CHUNK_SIZE} and dispatched sequentially under a per-host requests-per-minute throttle so the batch doesn't trip Zillow's PerimeterX bot-wall (issue #90). ` +
        'If the bot-wall is hit, the blocked sub-requests are retried with exponential backoff; anything still blocked is reported with `error_kind: "bot_challenge"` (distinct from a missing listing) and the response carries a `{ blocked, retry_after_s }` envelope so you can finish the rest in a second pass. ' +
        'The whole call is bounded by an overall hard deadline (issue #98): a single slow/hung row never wedges the server — when the deadline is reached any row that has not yet settled is returned with `error_kind: "pending"` and the response carries a `{ pending }` count so you can re-run just those ids.',
      annotations: {
        title: 'Bulk-fetch Zillow properties by zpid',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        zpids: z
          .array(z.union([z.number().int().positive(), z.string()]))
          .min(1)
          .max(BULK_GET_MAX)
          .optional()
          .describe(
            `Zpids to fetch. 1..${BULK_GET_MAX}. Provide either zpids or urls.`
          ),
        urls: z
          .array(z.string())
          .min(1)
          .max(BULK_GET_MAX)
          .optional()
          .describe(
            `Zillow homedetails URLs/paths to fetch. 1..${BULK_GET_MAX}.`
          ),
      },
    },
    async ({ zpids, urls }) => {
      const targets: Target[] | null =
        zpids && zpids.length > 0
          ? zpids.map((zpid) => ({ zpid }))
          : urls && urls.length > 0
            ? urls.map((url) => ({ url }))
            : null;
      if (!targets || targets.length === 0) {
        throw new Error(
          'zillow_bulk_get: provide either zpids[] or urls[] (1..' +
            BULK_GET_MAX +
            ').'
        );
      }

      // Issue #90: one shared token bucket governs total request volume
      // across the whole call (every page, every sub-request, every
      // captcha retry spends a token). Track the worst captcha retry-after
      // hint so the partial-result envelope can advise a wait.
      const bucket = new TokenBucket({
        ratePerMinute: cfg.ratePerMinute,
        burst: cfg.burst,
      });
      const blockedRetryAfter = { seconds: 0 };

      // Index-addressable result slots, one per input target. A slot
      // stays `undefined` until its fetch settles; if the overall
      // deadline (issue #98) fires first, every still-undefined slot is
      // backfilled with a `pending` marker so the response always has
      // exactly one row per input, in input order — and the call returns
      // partial results instead of hanging for the full client timeout.
      const slots: Array<BulkGetRow | undefined> = targets.map(() => undefined);

      // Auto-chunk into safe-sized pages dispatched sequentially (paced
      // dispatch). Within a page, fan out at BRIDGE_CONCURRENCY (#78); the
      // token bucket still gates the absolute request rate. We address
      // results by their original index so a partial (deadline-cut) batch
      // can still report every input slot.
      const indexed = targets.map((target, index) => ({ target, index }));
      const pages = chunk(indexed, cfg.chunkSize);
      const runAll = (async () => {
        for (const page of pages) {
          await mapWithConcurrency<{ target: Target; index: number }, void>(
            page,
            BRIDGE_CONCURRENCY,
            async ({ target, index }) => {
              slots[index] = await fetchOneRow(
                client,
                bucket,
                target,
                cfg,
                blockedRetryAfter
              );
            }
          );
        }
      })();

      // Issue #98: race the whole batch against an overall hard deadline.
      // On expiry the in-flight `runAll` promise is abandoned (left to
      // settle in the background and ignored) — critically, we do NOT
      // await it, so a permanently-hung row can't wedge the connection.
      await withDeadline(runAll, cfg.overallDeadlineMs);

      // Backfill any slot the deadline cut off as `pending`. The id comes
      // from the original target so the row is still identifiable and
      // re-runnable; a `pending` row is NEVER a generic miss / not-found.
      const rows: BulkGetRow[] = slots.map((row, index) => {
        if (row) return row;
        const target = targets[index];
        const zpid =
          target.zpid !== undefined
            ? String(target.zpid)
            : (target.url ?? '');
        return {
          zpid,
          error:
            'bulk_get overall deadline reached before this row settled — ' +
            'the request is still pending (likely a slow/hung sub-request). ' +
            'Re-run just the pending ids; a single slow row no longer wedges the batch.',
          error_kind: 'pending',
        };
      });

      const blocked = rows.filter(
        (r) => r.error_kind === 'bot_challenge'
      ).length;
      const pending = rows.filter((r) => r.error_kind === 'pending').length;

      const envelope: {
        count: number;
        rows: BulkGetRow[];
        blocked?: number;
        retry_after_s?: number;
        pending?: number;
      } = { count: rows.length, rows };
      if (blocked > 0) {
        // Partial result — some ids are still bot-walled. Surface the
        // count + a retry-after hint so the caller can re-run just the
        // blocked ids after waiting (issue #90).
        envelope.blocked = blocked;
        envelope.retry_after_s =
          blockedRetryAfter.seconds > 0 ? blockedRetryAfter.seconds : undefined;
      }
      if (pending > 0) {
        // Partial result — the overall deadline cut some rows off before
        // they settled (issue #98). Surface the count so the caller can
        // re-run just the pending ids.
        envelope.pending = pending;
      }
      return textResult(envelope);
    }
  );
}
