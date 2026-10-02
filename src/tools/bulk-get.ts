import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, runBoundedBatch } from '@chrischall/mcp-utils';
import {
  BRIDGE_CONCURRENCY,
  TokenBucket,
  backoffDelayMs,
  chunk,
  classifyRowError,
  retryOnceOnTimeout,
  sleep,
} from '@chrischall/mcp-utils/fetchproxy';
import { runRowBatch, throwIfAborted } from '@chrischall/realty-core';
import { BotWallError, type ZillowClient } from '../client.js';
import {
  fetchPropertyRecord,
  format,
  type FormattedProperty,
} from './properties.js';

// `chunk` comes from the shared resilience kit. The fan-out no longer
// pages internally (the deadline-bounded `runBoundedBatch` owns dispatch),
// but `chunk` stays re-exported so existing importers/tests keep their
// `bulk-get.js` import surface.
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
 *   - the fan-out is bounded to BRIDGE_CONCURRENCY in flight and paced by
 *     the RPM token bucket, keeping total volume under the px threshold;
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
 * Safe burst size. Empirically (issue #90) ~20 ids cleared the
 * PerimeterX wall while ~59 in one shot tripped it. Sizes the RPM token
 * bucket's burst allowance (one safe page worth of immediate tokens) so
 * the first wave of a big call doesn't slam Zillow. Still exposed as the
 * advertised page size in the tool description.
 */
export const BULK_GET_CHUNK_SIZE = 20;

/**
 * Per-host sustained request rate for Zillow, requests per minute. The
 * governor that keeps *total* volume under the bot-wall threshold
 * (issue #90 part b). Conservative: ~one request every ~0.4s sustained,
 * with a short burst allowance for the first page.
 */
export const ZILLOW_RPM = 150;
/** Burst allowance — one safe page worth of immediate tokens. */
export const ZILLOW_BURST = BULK_GET_CHUNK_SIZE;

/** Backoff schedule on a captcha block. */
const CAPTCHA_BACKOFF_BASE_MS = 1_000;
const CAPTCHA_BACKOFF_CAP_MS = 30_000;
/** How many times a captcha-blocked sub-request is retried before giving up. */
const CAPTCHA_MAX_RETRIES = 3;

/**
 * Overall hard deadline for the whole call (issue #98), in ms. The
 * deadline race + per-row `pending` backfill now live in the shared
 * `runBoundedBatch` from `@chrischall/mcp-utils` (hoisted from this MCP's
 * old local `runWithDeadline`), so `zillow_bulk_get` and
 * `zillow_resolve_addresses` share the exact same shape. Tuned to ~45s,
 * leaving margin under a 60s client timeout. `zillow_resolve_addresses`
 * imports this constant as its own default.
 */
export const OVERALL_DEADLINE_MS = 45_000;

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

type Target = { zpid?: number | string; url?: string };

/** The identity a caller needs to re-run a row: the zpid, else the URL. */
export function targetId(target: Target): string {
  return target.zpid !== undefined ? String(target.zpid) : (target.url ?? '');
}

/**
 * `classifyRowError` plus the bot-wall: a `BotWallError` that survived
 * its backoff retries is kind `bot_challenge` (the resilience kit's
 * canonical bot-wall kind, issue #90) — never a generic miss.
 */
function classifyBulkRowError(err: unknown): { kind: string; message: string } {
  if (err instanceof BotWallError) {
    return { kind: 'bot_challenge', message: err.message };
  }
  return classifyRowError(err);
}

/**
 * Fetch one target, with the #78 timeout retry (per sub-request) AND the
 * #90 bot-wall backoff retry layered on. Resolves to the row's success
 * fields or throws; realty-core's `runRowBatch` classifies a throw into
 * the row envelope.
 *
 * On a bot-wall block we back off (full jitter, floored at the wall's
 * own retry-after hint) and retry up to `maxCaptchaRetries`. If it never
 * clears, the final `BotWallError` is rethrown (→ `bot_challenge`) and
 * its retry-after seconds recorded for the envelope's `retry_after_s`.
 * The batch signal is re-checked before every token wait and after every
 * backoff sleep: a multi-request row stops once the deadline has
 * answered it `pending` (RowAbandonedError → `pending`, not an error).
 */
async function fetchOneRow(
  client: ZillowClient,
  bucket: TokenBucket,
  target: Target,
  cfg: Required<Omit<BulkGetTuning, 'rng'>> & { rng: () => number },
  blockedRetryAfter: { seconds: number },
  signal?: AbortSignal
): Promise<{ zpid: string; property: FormattedProperty }> {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    await bucket.acquire();
    throwIfAborted(signal);
    try {
      const { raw } = await retryOnceOnTimeout(() =>
        fetchPropertyRecord(client, target)
      );
      return { zpid: String(raw.zpid ?? targetId(target)), property: format(raw) };
    } catch (e) {
      if (!(e instanceof BotWallError)) throw e;
      if (attempt >= cfg.maxCaptchaRetries) {
        blockedRetryAfter.seconds = Math.max(
          blockedRetryAfter.seconds,
          e.retryAfterSeconds
        );
        throw e;
      }
      const retryAfterMs = Math.min(e.retryAfterSeconds * 1_000, cfg.backoffCapMs);
      await sleep(
        backoffDelayMs(attempt, {
          baseMs: cfg.backoffBaseMs,
          capMs: cfg.backoffCapMs,
          rng: cfg.rng,
          retryAfterMs,
        })
      );
    }
  }
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
        '`{ zpid, status: "ok", property }` on success or `{ zpid, status, error_kind, retryable, error }` on failure (`status` = `error_kind`) — one bad zpid never fails the ' +
        `whole call. Calls fan out concurrently against \`/homedetails/<zpid>_zpid/\` (capped at 6 in flight, per issue #78, with retry-once-on-timeout per sub-request to absorb transient SW evictions). ` +
        `Big lists fan out bounded to ${BRIDGE_CONCURRENCY} in flight and paced by a per-host requests-per-minute throttle (burst ${BULK_GET_CHUNK_SIZE}) so the batch doesn't trip Zillow's PerimeterX bot-wall (issue #90). ` +
        'If the bot-wall is hit, the blocked sub-requests are retried with exponential backoff; anything still blocked is reported with `error_kind: "bot_challenge"` (distinct from a missing listing) and the response carries a `{ blocked, retry_after_s }` envelope so you can finish the rest in a second pass. ' +
        'The whole call is bounded by an overall hard deadline (issue #98): a single slow/hung row never wedges the server — when the deadline is reached any row that has not yet settled is returned with `error_kind: "pending"` and the response carries a `{ pending }` count so you can re-run just those ids. The envelope also reports `count` / `ok` / `errored`.',
      annotations: {
        title: 'Bulk-fetch Zillow properties by zpid',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
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
      }),
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
      // across the whole call (every sub-request and every captcha retry
      // spends a token). Track the worst captcha retry-after hint so the
      // partial-result envelope can advise a wait.
      const bucket = new TokenBucket({
        ratePerMinute: cfg.ratePerMinute,
        burst: cfg.burst,
      });
      const blockedRetryAfter = { seconds: 0 };

      // Fan out at BRIDGE_CONCURRENCY (#78), bounded by the overall hard
      // deadline (#98), through realty-core's shared `runRowBatch`
      // (fleet-audit#1091): input-ordered rows, a `pending` backfill for
      // anything the deadline cut off (never a generic miss), and the
      // cohort envelope `{ count, ok, errored, pending?, blocked?, rows }`.
      // Every error row carries `status` = `error_kind` + `retryable`.
      // The shared `bucket` still gates the *absolute* request rate (the
      // bot-wall governor, #90 part b): every attempt spends a token.
      const rows = await runRowBatch(
        targets,
        (target, signal) =>
          fetchOneRow(client, bucket, target, cfg, blockedRetryAfter, signal),
        {
          // No kit retry: the timeout retry is per sub-request inside
          // fetchOneRow, so a timeout doesn't replay the captcha loop.
          kit: { runBoundedBatch, classifyRowError: classifyBulkRowError },
          toolLabel: 'zillow_bulk_get',
          rowBase: (target) => ({ zpid: targetId(target) }),
          deadlineMs: cfg.overallDeadlineMs,
          concurrency: BRIDGE_CONCURRENCY,
          resultsKey: 'rows',
        }
      );
      const envelope: typeof rows & { retry_after_s?: number } = rows;
      if ((envelope.blocked ?? 0) > 0 && blockedRetryAfter.seconds > 0) {
        // Partial result — some ids are still bot-walled. Advise a wait
        // before re-running just the blocked ids (issue #90).
        envelope.retry_after_s = blockedRetryAfter.seconds;
      }
      return minifiedResult(envelope);
    }
  );
}
