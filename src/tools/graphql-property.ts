/**
 * Property-detail fetch via Zillow's own persistedQuery GraphQL API
 * (issue #99). The SSR `/homedetails/<zpid>_zpid/` scrape trips
 * PerimeterX at scale (~20 ids ok, ~59 trips the bot-wall) even though
 * the site's GraphQL endpoint still serves the same listings. This path
 * is the primary property fetch; the SSR scrape stays as a fallback.
 *
 * Every request rides the user's signed-in browser via the fetchproxy
 * bridge, so cookies are supplied AMBIENTLY — this module NEVER sets,
 * reads, logs, or stores a cookie. The headers below are explicitly
 * cookie-free.
 *
 * Endpoint:
 *   GET https://www.zillow.com/graphql/
 *     ?extensions=<urlencoded {"persistedQuery":{"version":1,"sha256Hash":"<HASH>"}}>
 *     &variables=<urlencoded {"zpid":<id>,"altId":null,
 *                              "deviceTypeV2":"WEB_DESKTOP",
 *                              "includeLastSoldListing":true}>
 *
 * Response shape: { data: { property: { … } } } — full
 * resoFacts/priceHistory/taxHistory/address/lotAreaValue/etc, mapped
 * onto the existing FormattedProperty via `format()` in properties.ts.
 *
 * Persisted-query hashes are OPERATION-SPECIFIC and CAN ROTATE. On a
 * `PersistedQueryNotFound` response we throw {@link PersistedQueryNotFoundError}
 * — the hash must then be re-extracted from the page's bundled queries
 * and supplied via `ZILLOW_PROPERTY_QUERY_HASH` (or the constant bumped).
 */
import { SQFT_PER_ACRE } from '@chrischall/realty-core';
import type { ZillowClient } from '../client.js';
import { extractZpidFromUrl } from './properties.js';
import type { RawProperty } from './properties.js';

/**
 * Property-detail persisted-query `sha256Hash`, observed working
 * 2026-05 against Zillow's GraphQL endpoint. NAMED + configurable: this
 * is the operation identity, and Zillow rotates these per-deploy. Bump
 * the constant or set `ZILLOW_PROPERTY_QUERY_HASH` when it rotates.
 */
export const PROPERTY_DETAIL_SHA256_HASH =
  '28d4cee0936bc44b55b4f101de016bd409ed667a842848cf6086aa48e6c792f0';

/**
 * Resolve the active property-detail hash. Prefers the
 * `ZILLOW_PROPERTY_QUERY_HASH` env override (the rotation escape hatch)
 * and falls back to the documented constant.
 */
export function propertyDetailHash(): string {
  const override = process.env.ZILLOW_PROPERTY_QUERY_HASH?.trim();
  return override && override.length > 0
    ? override
    : PROPERTY_DETAIL_SHA256_HASH;
}

/** Raised when the persisted-query hash no longer matches a registered
 *  operation (Zillow rotated it). Distinct + actionable: the recovery is
 *  to re-extract the hash from the page's bundled queries. */
export class PersistedQueryNotFoundError extends Error {
  constructor(hash: string) {
    super(
      `Zillow's GraphQL endpoint rejected the persisted-query hash ` +
        `(${hash}) with PersistedQueryNotFound — the property-detail query ` +
        `hash has rotated. Re-extract the current sha256Hash from zillow.com's ` +
        `bundled queries (open a homedetails page, inspect the /graphql/ ` +
        `requests) and set ZILLOW_PROPERTY_QUERY_HASH to it (or update ` +
        `PROPERTY_DETAIL_SHA256_HASH in graphql-property.ts).`
    );
    this.name = 'PersistedQueryNotFoundError';
  }
}

/** Minimal typed view of the GraphQL response (success + error arms). */
export interface GraphqlPropertyResponse {
  data?: { property?: RawGraphqlProperty | null };
  errors?: Array<{ message?: string; extensions?: Record<string, unknown> }>;
}

/**
 * The GraphQL `property` payload. A superset of {@link RawProperty}
 * (same field names — resoFacts/priceHistory/taxHistory/address/etc) plus
 * the GraphQL-only lot fields, which we normalize into `lotSize`.
 */
export interface RawGraphqlProperty extends RawProperty {
  /** GraphQL lot size value; units in {@link lotAreaUnits}. */
  lotAreaValue?: number;
  /** Units for {@link lotAreaValue} — e.g. "sqft" or "acres". */
  lotAreaUnits?: string;
}

interface GraphqlArgs {
  zpid: number | string;
  /** Optional homedetails slug (the `<slug>` in `/homedetails/<slug>/<zpid>_zpid/`)
   *  used to build a realistic referer. Defaults to the bare zpid path. */
  slug?: string;
  /** A full Zillow homedetails URL/path. The zpid is derived from it, and
   *  the slug is too when the url carries the `/homedetails/<slug>/<zpid>_zpid/`
   *  form (an explicit `slug` takes precedence). */
  url?: string;
}

/**
 * URL-encode `extensions` + `variables` into the `/graphql/` query path.
 * Returns a path (origin prepended by the transport), not a full URL.
 */
export function buildGraphqlPropertyPath(args: {
  zpid: number | string;
}): string {
  // Numeric zpid in the variables when possible — Zillow's schema expects
  // an Int. Fall back to the raw value for non-numeric inputs.
  const zpidNum =
    typeof args.zpid === 'number'
      ? args.zpid
      : /^\d+$/.test(args.zpid)
        ? Number(args.zpid)
        : args.zpid;
  const extensions = JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: propertyDetailHash() },
  });
  const variables = JSON.stringify({
    zpid: zpidNum,
    altId: null,
    deviceTypeV2: 'WEB_DESKTOP',
    includeLastSoldListing: true,
  });
  const qs = new URLSearchParams({ extensions, variables });
  return `/graphql/?${qs.toString()}`;
}

/**
 * Build the request headers. Cookie-free by construction — the bridge
 * supplies the session ambiently. The referer mimics a real homedetails
 * navigation (Zillow gates the endpoint on a plausible referer).
 */
export function graphqlPropertyHeaders(args: GraphqlArgs): Record<string, string> {
  const slug = args.slug && args.slug.length > 0 ? `${args.slug}/` : '';
  return {
    accept: '*/*',
    'content-type': 'application/json',
    'client-id': 'not-for-sale-sub-app-browser-client',
    'x-z-enable-oauth-conversion': 'true',
    referer: `https://www.zillow.com/homedetails/${slug}${args.zpid}_zpid/`,
  };
}

/**
 * Normalize the GraphQL lot fields onto the canonical `lotSize` (sqft)
 * that `format()` understands, without clobbering an explicit `lotSize`.
 */
function normalizeLot(raw: RawGraphqlProperty): RawProperty {
  if (typeof raw.lotSize === 'number' || typeof raw.lotAreaValue !== 'number') {
    return raw;
  }
  const units = (raw.lotAreaUnits ?? '').toLowerCase();
  const sqft = units.startsWith('acre')
    ? raw.lotAreaValue * SQFT_PER_ACRE
    : raw.lotAreaValue;
  return { ...raw, lotSize: sqft };
}

/** Capture the `<slug>` from a `/homedetails/<slug>/<zpid>_zpid/` url. */
const HOMEDETAILS_SLUG_RE = /\/homedetails\/([^/]+)\/\d+_zpid(?:\/|$)/;

/** Extract the homedetails slug from a url, or undefined if none is present. */
function extractSlugFromUrl(url: string): string | undefined {
  const m = HOMEDETAILS_SLUG_RE.exec(url);
  return m ? m[1] : undefined;
}

/**
 * Derive zpid + slug from a GraphqlArgs that may carry a `url` instead.
 * An explicit `slug` wins; otherwise the slug is derived from the `url`
 * (when it carries the `/homedetails/<slug>/<zpid>_zpid/` form) so the
 * referer uses the full slugged path rather than the bare-zpid fallback.
 */
function resolveTarget(args: GraphqlArgs): { zpid: number | string; slug?: string } {
  if (args.url) {
    const zpid = extractZpidFromUrl(args.url) ?? args.zpid;
    const slug = args.slug ?? extractSlugFromUrl(args.url);
    return { zpid, slug };
  }
  return { zpid: args.zpid, slug: args.slug };
}

/**
 * Primary property fetch (issue #99). GETs the persistedQuery GraphQL
 * endpoint through the bridge, validates the GraphQL envelope, and
 * returns the raw property in the same `{ raw, path }` shape as the SSR
 * `fetchPropertyRecord`, so callers can format it identically.
 *
 * Throws:
 *   - {@link PersistedQueryNotFoundError} when the hash has rotated.
 *   - a plain Error naming the GraphQL error(s) otherwise.
 *   - a plain Error when a 200 carries no property (genuine miss).
 *
 * Bot-wall + sign-in classification stays in `ZillowClient.fetchJson`,
 * which runs `classifyBotWall` first — a px-walled GraphQL response still
 * surfaces as a `BotWallError`.
 */
export async function fetchPropertyViaGraphql(
  client: ZillowClient,
  args: GraphqlArgs
): Promise<{ raw: RawProperty; path: string }> {
  const target = resolveTarget(args);
  const path = buildGraphqlPropertyPath({ zpid: target.zpid });
  const headers = graphqlPropertyHeaders(target);

  const resp = await client.fetchJson<GraphqlPropertyResponse>(path, {
    method: 'GET',
    headers,
  });

  if (resp?.errors && resp.errors.length > 0) {
    const isPersistedQueryMiss = resp.errors.some(
      (e) =>
        e.message === 'PersistedQueryNotFound' ||
        e.extensions?.code === 'PERSISTED_QUERY_NOT_FOUND'
    );
    if (isPersistedQueryMiss) {
      throw new PersistedQueryNotFoundError(propertyDetailHash());
    }
    const messages = resp.errors
      .map((e) => e.message ?? 'unknown GraphQL error')
      .join('; ');
    throw new Error(`Zillow GraphQL error for zpid ${target.zpid}: ${messages}`);
  }

  const property = resp?.data?.property;
  if (!property) {
    throw new Error(
      `Zillow GraphQL returned no property for zpid ${target.zpid} ` +
        `(the listing may not exist, or the response shape changed).`
    );
  }

  return { raw: normalizeLot(property), path };
}
