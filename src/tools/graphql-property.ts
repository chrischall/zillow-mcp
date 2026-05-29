/**
 * Property-detail fetch via Zillow's own GraphQL API (issues #99/#102).
 * The SSR `/homedetails/<zpid>_zpid/` scrape trips PerimeterX at scale
 * (~20 ids ok, ~59 trips the bot-wall) even though the site's GraphQL
 * endpoint still serves the same listings. This path is the primary
 * property fetch; the SSR scrape stays as the floor.
 *
 * "Shirk the hash" (this PR): the PRIMARY GraphQL call no longer rides a
 * static, manually-managed persisted-query `sha256Hash`. Instead it POSTs
 * a FULL INLINE query string we author here — `{ operationName, query,
 * variables }`. Zillow rotates persisted-query hashes per-deploy, so a
 * pinned constant goes stale and silently drops us to SSR (which trips
 * PerimeterX). The inline query carries the operation by value, so there
 * is nothing to rotate. (Evidence the endpoint is not strictly safelisted:
 * Zillow's own autocomplete endpoint accepts a full inline query in a
 * POST body.)
 *
 * Fallback chain:
 *   1. PRIMARY  — inline POST (no hash). {@link fetchInlinePropertyDetail}
 *   2. FALLBACK — persisted GET, ONLY when `ZILLOW_PROPERTY_QUERY_HASH`
 *      is explicitly set (operator override / safelist escape hatch).
 *   3. FLOOR    — SSR scrape (in properties.ts), unchanged.
 *
 * Every request rides the user's signed-in browser via the fetchproxy
 * bridge, so cookies are supplied AMBIENTLY — this module NEVER sets,
 * reads, logs, or stores a cookie. The headers below are explicitly
 * cookie-free.
 *
 * Endpoints:
 *   POST https://www.zillow.com/graphql/   (inline; body carries the query)
 *   GET  https://www.zillow.com/graphql/
 *     ?extensions=<urlencoded {"persistedQuery":{"version":1,"sha256Hash":"<HASH>"}}>
 *     &variables=<urlencoded {"zpid":<id>,…}>   (persisted fallback)
 *
 * Response shape (identical for inline + persisted): { data: { property:
 * { … } } } — full resoFacts/priceHistory/taxHistory/address/
 * lotAreaValue/etc, mapped onto the existing FormattedProperty via
 * `format()` in properties.ts.
 */
import { SQFT_PER_ACRE } from '@chrischall/realty-core';
import type { ZillowClient } from '../client.js';
import { extractZpidFromUrl } from './properties.js';
import type { RawProperty } from './properties.js';

/** The bare GraphQL endpoint path — the inline POST target (no query string). */
export const GRAPHQL_ENDPOINT_PATH = '/graphql/';

/** GraphQL operation name for the inline property-detail query. */
export const PROPERTY_DETAIL_OPERATION_NAME = 'PropertyDetail';

/**
 * Full inline property-detail GraphQL query — the PRIMARY fetch, with NO
 * persisted-query hash. We author the operation by value here so there is
 * nothing to rotate.
 *
 * Field selection: EXACTLY the `property { … }` keys the downstream parser
 * consumes (GraphQL field names == the response keys `format()` /
 * `normalizeLot()` / the history+tax formatters read). The selection set
 * mirrors {@link RawProperty} + {@link RawGraphqlProperty} (lot fields) +
 * the nested `RawResoFacts` / `RawPriceHistoryEntry` / `RawTaxHistoryEntry`
 * / schools shapes. Keep this in sync with those types — an over-broad
 * selection risks a schema rejection that needlessly falls through to SSR.
 *
 * The operation args mirror the persisted query's variables — `zpid`,
 * `altId`, `deviceTypeV2`, `includeLastSoldListing`. The exact arg TYPES
 * (`ID!`, `ID`, `DeviceType`, `Boolean`) are INFERRED from those variable
 * values + the known response shape; live confirmation happens through
 * normal usage (any inline failure falls through, so it is never a
 * regression vs the hash-based path).
 */
export const PROPERTY_DETAIL_INLINE_QUERY = `query ${PROPERTY_DETAIL_OPERATION_NAME}($zpid: ID!, $altId: ID, $deviceTypeV2: DeviceType, $includeLastSoldListing: Boolean) {
  property(zpid: $zpid, altId: $altId, deviceTypeV2: $deviceTypeV2, includeLastSoldListing: $includeLastSoldListing) {
    zpid
    hdpUrl
    price
    zestimate
    rentZestimate
    bedrooms
    bathrooms
    livingArea
    lotSize
    lotAreaValue
    lotAreaUnits
    yearBuilt
    homeType
    homeStatus
    description
    latitude
    longitude
    daysOnZillow
    pageViewCount
    favoriteCount
    taxAssessedValue
    taxAssessedYear
    mlsStreetAddress
    monthlyHoaFee
    taxAnnualAmount
    previousPrice
    timeOnZillow
    altAddresses
    address {
      streetAddress
      city
      state
      zipcode
      neighborhood
    }
    resoFacts {
      yearBuilt
      associationFee
      associationFeeFrequency
      taxAnnualAmount
    }
    priceHistory {
      date
      time
      event
      price
      priceChangeRate
      pricePerSquareFoot
      source
      attributeSource {
        infoString1
        infoString2
        infoString3
      }
    }
    taxHistory {
      time
      taxPaid
      taxIncreaseRate
      value
      valueIncreaseRate
    }
    schools {
      name
      rating
      grades
      distance
      type
      studentsPerTeacher
    }
  }
}`;

/**
 * Property-detail persisted-query `sha256Hash`, observed working
 * 2026-05 against Zillow's GraphQL endpoint. RETAINED ONLY as the
 * operator-override fallback's default value — the inline query above is
 * the primary path and needs no hash. Bump the constant or set
 * `ZILLOW_PROPERTY_QUERY_HASH` only if you deliberately want the persisted
 * fallback to carry a specific hash.
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
 *  to re-extract the hash from the page's bundled queries. Reaches this
 *  layer ONLY via the operator-override persisted fallback (`ZILLOW_PROPERTY_QUERY_HASH`);
 *  the inline-primary path needs no hash. */
export class PersistedQueryNotFoundError extends Error {
  constructor(hash: string) {
    super(
      `Zillow's GraphQL endpoint rejected the persisted-query hash ` +
        `(${hash}) with PersistedQueryNotFound — the property-detail query ` +
        `hash has rotated. The inline-primary path needs no hash, so this ` +
        `only fires when ZILLOW_PROPERTY_QUERY_HASH is set; re-extract the ` +
        `current sha256Hash from zillow.com's bundled queries (open a ` +
        `homedetails page, inspect the /graphql/ requests) and update the ` +
        `override, or simply unset it to rely on the inline query.`
    );
    this.name = 'PersistedQueryNotFoundError';
  }
}

/**
 * Raised when a GraphQL response carries a *validation* `errors[]` — i.e.
 * the server rejected the inline operation's shape (e.g. "Cannot query
 * field … on type Property", an unknown arg/type). DISTINCT from a
 * `PersistedQueryNotFound` (hash rotation) and from a bot-wall: a
 * validation miss means the curated inline query drifted from Zillow's
 * current schema, and the safe recovery is to fall through (persisted
 * fallback if an override is set, else the SSR floor) rather than bubble.
 * Carries the joined GraphQL messages for diagnostics.
 */
export class GraphqlValidationError extends Error {
  constructor(zpid: number | string, messages: string) {
    super(
      `Zillow GraphQL rejected the inline property-detail query for zpid ` +
        `${zpid}: ${messages}. Falling through to the next layer (persisted ` +
        `fallback if ZILLOW_PROPERTY_QUERY_HASH is set, else the SSR scrape).`
    );
    this.name = 'GraphqlValidationError';
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

/** The GraphQL operation variables — shared by the inline body and the
 *  persisted query string so both carry an identical arg set. */
interface PropertyDetailVariables {
  zpid: number | string;
  altId: null;
  deviceTypeV2: 'WEB_DESKTOP';
  includeLastSoldListing: true;
}

/** Build the operation variables, coercing a numeric-string zpid to a
 *  number (Zillow's schema keys on a numeric id). */
function propertyDetailVariables(zpid: number | string): PropertyDetailVariables {
  const zpidNum =
    typeof zpid === 'number'
      ? zpid
      : /^\d+$/.test(zpid)
        ? Number(zpid)
        : zpid;
  return {
    zpid: zpidNum,
    altId: null,
    deviceTypeV2: 'WEB_DESKTOP',
    includeLastSoldListing: true,
  };
}

/** The inline GraphQL POST body — `{ operationName, query, variables }`,
 *  NO persisted-query extensions. This is the primary fetch's payload. */
export interface InlineGraphqlBody {
  operationName: string;
  query: string;
  variables: PropertyDetailVariables;
}

/**
 * Build the inline POST body for the property-detail query. Carries the
 * full query string by value — there is NO hash to manage or rotate.
 */
export function buildInlineGraphqlBody(args: {
  zpid: number | string;
}): InlineGraphqlBody {
  return {
    operationName: PROPERTY_DETAIL_OPERATION_NAME,
    query: PROPERTY_DETAIL_INLINE_QUERY,
    variables: propertyDetailVariables(args.zpid),
  };
}

/**
 * URL-encode `extensions` + `variables` into the `/graphql/` query path
 * for the PERSISTED fallback (operator-override only). Returns a path
 * (origin prepended by the transport), not a full URL.
 */
export function buildGraphqlPropertyPath(args: {
  zpid: number | string;
}): string {
  const extensions = JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: propertyDetailHash() },
  });
  const variables = JSON.stringify(propertyDetailVariables(args.zpid));
  const qs = new URLSearchParams({ extensions, variables });
  return `${GRAPHQL_ENDPOINT_PATH}?${qs.toString()}`;
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

/** True when `resp.errors[]` carries a persisted-query-miss marker. */
function isPersistedQueryMiss(resp: GraphqlPropertyResponse): boolean {
  return Boolean(
    resp.errors?.some(
      (e) =>
        e.message === 'PersistedQueryNotFound' ||
        e.extensions?.code === 'PERSISTED_QUERY_NOT_FOUND'
    )
  );
}

/** Join a response's GraphQL error messages for diagnostics. */
function joinErrors(resp: GraphqlPropertyResponse): string {
  return (resp.errors ?? [])
    .map((e) => e.message ?? 'unknown GraphQL error')
    .join('; ');
}

/**
 * Interpret a GraphQL envelope into a raw property, or throw the
 * appropriately-classified error. Shared by the inline + persisted layers
 * (the `{ data: { property } }` / `errors[]` shape is identical for both).
 *
 * Throws:
 *   - {@link PersistedQueryNotFoundError} on a persisted-query miss.
 *   - {@link GraphqlValidationError} on any other GraphQL `errors[]`
 *     (the inline op's shape was rejected) — distinct so callers can fall
 *     through rather than bubble.
 *   - a plain Error when a 200 carries no property (genuine miss).
 *
 * Bot-wall + sign-in classification stays upstream in
 * `ZillowClient.fetchJson` (which runs `classifyBotWall` first), so a
 * px-walled response is already a `BotWallError` before reaching here.
 */
function interpretResponse(
  resp: GraphqlPropertyResponse,
  zpid: number | string
): RawProperty {
  if (resp?.errors && resp.errors.length > 0) {
    if (isPersistedQueryMiss(resp)) {
      throw new PersistedQueryNotFoundError(propertyDetailHash());
    }
    throw new GraphqlValidationError(zpid, joinErrors(resp));
  }
  const property = resp?.data?.property;
  if (!property) {
    throw new Error(
      `Zillow GraphQL returned no property for zpid ${zpid} ` +
        `(the listing may not exist, or the response shape changed).`
    );
  }
  return normalizeLot(property);
}

/**
 * PRIMARY fetch — inline POST (NO hash). POSTs the full inline query body
 * to the bare `/graphql/` endpoint with cookie-free headers + a slugged
 * referer, and interprets the envelope.
 */
async function fetchInlinePropertyDetail(
  client: ZillowClient,
  target: { zpid: number | string; slug?: string }
): Promise<{ raw: RawProperty; path: string }> {
  const resp = await client.fetchJson<GraphqlPropertyResponse>(
    GRAPHQL_ENDPOINT_PATH,
    {
      method: 'POST',
      headers: graphqlPropertyHeaders(target),
      body: buildInlineGraphqlBody({ zpid: target.zpid }),
    }
  );
  return { raw: interpretResponse(resp, target.zpid), path: GRAPHQL_ENDPOINT_PATH };
}

/**
 * FALLBACK fetch — persisted GET, gated on an explicit
 * `ZILLOW_PROPERTY_QUERY_HASH` override (operator / safelist escape
 * hatch). Demoted: not part of the normal path.
 */
async function fetchPersistedPropertyDetail(
  client: ZillowClient,
  target: { zpid: number | string; slug?: string }
): Promise<{ raw: RawProperty; path: string }> {
  const path = buildGraphqlPropertyPath({ zpid: target.zpid });
  const resp = await client.fetchJson<GraphqlPropertyResponse>(path, {
    method: 'GET',
    headers: graphqlPropertyHeaders(target),
  });
  return { raw: interpretResponse(resp, target.zpid), path };
}

/** True when an operator has explicitly pinned a persisted-query hash. */
function hasPersistedHashOverride(): boolean {
  const override = process.env.ZILLOW_PROPERTY_QUERY_HASH?.trim();
  return Boolean(override && override.length > 0);
}

/**
 * Property fetch via Zillow's GraphQL endpoint, returning the raw property
 * in the same `{ raw, path }` shape as the SSR `fetchPropertyRecord` so
 * callers format it identically.
 *
 * "Shirk the hash" fallback chain:
 *   1. PRIMARY  — inline POST (no hash). {@link fetchInlinePropertyDetail}
 *   2. FALLBACK — persisted GET, ONLY when `ZILLOW_PROPERTY_QUERY_HASH`
 *      is set. {@link fetchPersistedPropertyDetail}
 * The SSR floor lives one layer up in `fetchPropertyRecord`.
 *
 * A {@link GraphqlValidationError} from the inline op falls through to the
 * persisted fallback (if an override is set), else propagates so the SSR
 * floor can catch it. A {@link BotWallError} at ANY layer propagates
 * (never buried as a validation miss).
 */
export async function fetchPropertyViaGraphql(
  client: ZillowClient,
  args: GraphqlArgs
): Promise<{ raw: RawProperty; path: string }> {
  const target = resolveTarget(args);

  try {
    return await fetchInlinePropertyDetail(client, target);
  } catch (e) {
    // Only a GraphQL VALIDATION miss is eligible to fall through to the
    // persisted fallback. A bot-wall, persisted-query-miss (can't happen
    // on the inline path, but be defensive), genuine "no property" miss,
    // or transport error all propagate to the SSR floor / caller.
    if (!(e instanceof GraphqlValidationError) || !hasPersistedHashOverride()) {
      throw e;
    }
    // Operator pinned a hash → try the demoted persisted GET. A BotWallError
    // / PersistedQueryNotFoundError here propagates by design.
    return await fetchPersistedPropertyDetail(client, target);
  }
}
