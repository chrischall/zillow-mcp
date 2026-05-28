import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
} from '@fetchproxy/server';
import { CaptchaBlockedError, type ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { backoffDelayMs, sleep } from '../backoff.js';
import { chunk, TokenBucket } from '../throttle.js';
import {
  fetchPropertyRecord,
  format,
  type FormattedProperty,
} from './properties.js';

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
 * Issue #90 hardening — PerimeterX bot-wall:
 *   - a px-captcha 403 is classified as `rate_limited_captcha`, a
 *     distinct kind that NEVER masquerades as not-found / generic error;
 *   - a per-host requests-per-minute token bucket governs *total*
 *     request volume (not just concurrency — that's what trips px);
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
   * critical value is `rate_limited_captcha` — distinct from a generic
   * `error`/not-found so a bot-wall is never mistaken for a gone listing.
   */
  error_kind?:
    | 'rate_limited_captcha'
    | 'timeout'
    | 'bridge_down'
    | 'protocol'
    | 'other';
}

type Target = { zpid?: number | string; url?: string };

/**
 * Fetch one target, with the #78 timeout retry AND the #90 captcha
 * backoff retry layered on. Returns a per-row envelope; never throws.
 *
 * On a captcha block we back off (full jitter, floored at the captcha's
 * own retry-after hint) and retry up to `maxCaptchaRetries`. If it never
 * clears, the row is returned with `error_kind: 'rate_limited_captcha'`
 * and the captcha's retry-after seconds so the caller can finish it in a
 * second pass — it is NEVER downgraded to a generic miss.
 */
async function fetchOneRow(
  client: ZillowClient,
  bucket: TokenBucket,
  target: Target,
  cfg: Required<Omit<BulkGetTuning, 'rng'>> & { rng: () => number },
  blockedRetryAfter: { seconds: number }
): Promise<BulkGetRow> {
  const fallbackZpid = 'zpid' in target ? String(target.zpid) : '';
  let lastCaptcha: CaptchaBlockedError | null = null;

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
      if (e instanceof CaptchaBlockedError) {
        lastCaptcha = e;
        if (attempt < cfg.maxCaptchaRetries) {
          // Honour the captcha's retry-after hint as a floor, but never
          // wait longer than the backoff cap on a single in-batch retry —
          // a 30s server hint shouldn't stall the whole batch. Anything
          // still blocked after the bounded retries is reported in the
          // partial-result envelope with the *full* retry-after for a
          // second pass.
          const floorMs = Math.min(
            e.retryAfterSeconds * 1_000,
            cfg.backoffCapMs
          );
          const delay = backoffDelayMs(attempt, {
            baseMs: cfg.backoffBaseMs,
            capMs: cfg.backoffCapMs,
            rng: cfg.rng,
            floorMs,
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
          error_kind: 'rate_limited_captcha',
        };
      }
      // Non-captcha failure: classify with the cohort helper (timeout /
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
    lastCaptcha?.retryAfterSeconds ?? 0
  );
  return {
    zpid: fallbackZpid,
    error: lastCaptcha?.message ?? 'unknown bulk-get failure',
    error_kind: lastCaptcha ? 'rate_limited_captcha' : 'other',
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
        'If the bot-wall is hit, the blocked sub-requests are retried with exponential backoff; anything still blocked is reported with `error_kind: "rate_limited_captcha"` (distinct from a missing listing) and the response carries a `{ blocked, retry_after_s }` envelope so you can finish the rest in a second pass.',
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

      // Auto-chunk into safe-sized pages dispatched sequentially (paced
      // dispatch). Within a page, fan out at BRIDGE_CONCURRENCY (#78); the
      // token bucket still gates the absolute request rate.
      const pages = chunk(targets, cfg.chunkSize);
      const rows: BulkGetRow[] = [];
      for (const page of pages) {
        const pageRows = await mapWithConcurrency<Target, BulkGetRow>(
          page,
          BRIDGE_CONCURRENCY,
          (t) => fetchOneRow(client, bucket, t, cfg, blockedRetryAfter)
        );
        rows.push(...pageRows);
      }

      const blocked = rows.filter(
        (r) => r.error_kind === 'rate_limited_captcha'
      ).length;

      const envelope: {
        count: number;
        rows: BulkGetRow[];
        blocked?: number;
        retry_after_s?: number;
      } = { count: rows.length, rows };
      if (blocked > 0) {
        // Partial result — some ids are still bot-walled. Surface the
        // count + a retry-after hint so the caller can re-run just the
        // blocked ids after waiting (issue #90).
        envelope.blocked = blocked;
        envelope.retry_after_s =
          blockedRetryAfter.seconds > 0 ? blockedRetryAfter.seconds : undefined;
      }
      return textResult(envelope);
    }
  );
}
