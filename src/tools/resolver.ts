/**
 * Shared 3-rung address-resolution strategy used by both
 * `zillow_get_by_address` (single) and `zillow_resolve_addresses` (bulk).
 *
 * Issue #73 — bulk used to run only rung 1 (direct), so a real-world
 * 20-address batch returned 0/20 while the single tool's 3-rung ladder
 * resolved 17/20. Factoring the ladder here keeps the two tools at
 * parity by construction.
 *
 * Ladder (each rung tried only when the prior misses):
 *   1. Direct          — `/homes/<slug>_rb/`
 *   2. Suffix expansion — `Rd <-> Road`, `Hts <-> Heights` (issue #51 + #76)
 *   3. Search fallback  — city/state-scoped search bounded by an
 *                          optional price band (issue #52, plumbed
 *                          through to bulk in issue #74)
 */
import type { ZillowClient } from '../client.js';
import { ParseError } from '../next-data.js';
import {
  buildSearchPath,
  buildSearchQueryState,
  extractSearchPageState,
  formatListing,
  listingsMatchLocation,
  locationTokens,
  resolveLocationOrListings,
  type RawListing,
} from './search.js';

export interface ResolverInput {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Optional price band for the search-fallback rung (issue #52/#74). */
  price_min?: number;
  price_max?: number;
}

export type ResolverVia = 'direct' | 'suffix_expansion' | 'search_fallback';

export interface ResolverHit {
  raw: RawListing;
  formatted: NonNullable<ReturnType<typeof formatListing>>;
  via: ResolverVia;
  /** The slug actually passed to the upstream that produced the hit. */
  slug: string;
}

export interface ResolverMiss {
  slug: string;
}

/**
 * Join the address parts into a single space-separated phrase suitable
 * for Zillow's `/homes/<slug>_rb/` resolver. Missing parts are skipped.
 */
export function buildAddressSlug(
  input: Pick<ResolverInput, 'address' | 'city' | 'state' | 'zip'>
): string {
  return [input.address, input.city, input.state, input.zip]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/**
 * One direct-resolver pass: fetch `/homes/<slug>_rb/` and return the
 * first listing if it matches the input tokens. Returns null on miss.
 */
export async function resolveDirect(
  client: ZillowClient,
  slug: string
): Promise<{ raw: RawListing; formatted: NonNullable<ReturnType<typeof formatListing>> } | null> {
  const path = buildSearchPath(slug);
  const html = await client.fetchHtml(path);
  let sps: ReturnType<typeof extractSearchPageState>;
  try {
    sps = extractSearchPageState(html);
  } catch (e) {
    if (e instanceof ParseError) return null;
    throw e;
  }
  const firstRaw: RawListing | undefined =
    sps?.cat1?.searchResults?.listResults?.[0];
  if (!firstRaw) return null;
  const formatted = formatListing(firstRaw);
  if (!formatted) return null;
  if (!listingsMatchLocation([firstRaw], locationTokens(slug))) return null;
  return { raw: firstRaw, formatted };
}

/**
 * Search-fallback rung (#52). Builds a city/state-scoped search with
 * the caller's optional price band and picks the first listing whose
 * address tokens overlap with the caller's street address.
 */
export async function searchFallback(
  client: ZillowClient,
  input: ResolverInput
): Promise<RawListing | null> {
  const scope = input.city ?? input.zip;
  if (!scope) return null;
  const scopeParts = [input.city, input.state, input.zip]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .join(' ');
  let resolved;
  try {
    resolved = await resolveLocationOrListings(client, scopeParts);
  } catch {
    return null;
  }
  let listings: RawListing[];
  if (resolved.kind === 'listings') {
    listings = resolved.listings;
  } else {
    const sqs = buildSearchQueryState(
      {
        location: scopeParts,
        ...(input.price_min !== undefined ? { price_min: input.price_min } : {}),
        ...(input.price_max !== undefined ? { price_max: input.price_max } : {}),
      },
      resolved.region
    );
    const html = await client.fetchHtml(buildSearchPath(scopeParts, sqs));
    let sps: ReturnType<typeof extractSearchPageState>;
    try {
      sps = extractSearchPageState(html);
    } catch (e) {
      if (e instanceof ParseError) return null;
      throw e;
    }
    listings = sps?.cat1?.searchResults?.listResults ?? [];
  }
  if (listings.length === 0) return null;
  const inputTokens = locationTokens(input.address).filter((t) => t.length >= 3);
  if (inputTokens.length === 0) return listings[0];
  for (const l of listings) {
    const info = l.hdpData?.homeInfo ?? {};
    const haystack = [info.streetAddress, l.address, l.addressStreet]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (inputTokens.every((t) => haystack.includes(t))) return l;
  }
  return null;
}

/**
 * Generate ordered street-address variants to try in rung 2. The first
 * is always the original (already tried in rung 1 by the caller — the
 * caller skips index 0). Subsequent entries cover:
 *
 *   - bidirectional suffix swap (`Rd` <-> `Road`, `Hts` <-> `Heights`)
 *     — issue #76
 *   - space-insensitive compound-token splits/joins
 *     (`Bluebird` <-> `Blue Bird`, `Pinegrove` <-> `Pine Grove`)
 *     — issue #76
 *
 * Deduplicates while preserving order.
 */
export function streetAddressVariants(address: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    if (!v) return;
    const k = v.trim();
    if (k.length === 0 || seen.has(k.toLowerCase())) return;
    seen.add(k.toLowerCase());
    out.push(k);
  };
  push(address);
  // Suffix swap (bidirectional).
  push(swapStreetSuffix(address));
  // Compound-token splits/joins.
  for (const v of compoundTokenVariants(address)) push(v);
  // Compound-then-suffix-swap and vice-versa to catch addresses that
  // need both (e.g. "Bluebird Rd" -> "Blue Bird Road").
  const suffixSwapped = swapStreetSuffix(address);
  if (suffixSwapped) {
    for (const v of compoundTokenVariants(suffixSwapped)) push(v);
  }
  for (const v of compoundTokenVariants(address)) {
    push(swapStreetSuffix(v));
  }
  return out;
}

/**
 * Bidirectional street-suffix expansion table. Each pair is registered
 * both ways: `Rd <-> Road`, `Hts <-> Heights`. USPS publication 28
 * lists ~250 suffixes; we cover the common ones we've seen miss-and-
 * retry in real sessions. Add as needed.
 */
const SUFFIX_PAIRS: Array<[string, string]> = [
  ['ave', 'Avenue'],
  ['blvd', 'Boulevard'],
  ['cir', 'Circle'],
  ['ct', 'Court'],
  ['dr', 'Drive'],
  ['hwy', 'Highway'],
  ['hts', 'Heights'],
  ['ln', 'Lane'],
  ['mtn', 'Mountain'],
  ['pl', 'Place'],
  ['pkwy', 'Parkway'],
  ['rd', 'Road'],
  ['sq', 'Square'],
  ['st', 'Street'],
  ['ter', 'Terrace'],
  ['trl', 'Trail'],
];

const SUFFIX_EXPANSIONS: Record<string, string> = Object.fromEntries(
  SUFFIX_PAIRS.map(([abbr, full]) => [abbr, full])
);
const SUFFIX_CONTRACTIONS: Record<string, string> = Object.fromEntries(
  SUFFIX_PAIRS.map(([abbr, full]) => [full.toLowerCase(), titleCase(abbr)])
);

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Bidirectional suffix swap. Anchored to the LAST whitespace-separated
 * token so mid-name occurrences ("Roderick Dr") swap "Dr", not "Rd".
 * Returns null when no recognized suffix sits at the end.
 */
export function swapStreetSuffix(address: string): string | null {
  const trimmed = address.trim();
  const m = /(\s+)([A-Za-z]+)(\.?)\s*$/.exec(trimmed);
  if (!m) return null;
  const [, lead, token] = m;
  const key = token.toLowerCase();
  const head = trimmed.slice(0, m.index);
  if (SUFFIX_EXPANSIONS[key]) {
    return `${head}${lead}${SUFFIX_EXPANSIONS[key]}`;
  }
  if (SUFFIX_CONTRACTIONS[key]) {
    return `${head}${lead}${SUFFIX_CONTRACTIONS[key]}`;
  }
  return null;
}

/**
 * Compound-token split/join (issue #76). For each candidate street-name
 * token, emit a variant that splits it (`Bluebird` -> `Blue Bird`) and
 * a variant that joins consecutive capitalized tokens (`Blue Bird` ->
 * `Bluebird`). The address is tokenized on whitespace; the leading
 * house-number token and the trailing suffix are preserved verbatim.
 *
 * Heuristic split: a CamelCase boundary OR a known two-word compound
 * (Blue, Pine, Oak, etc.). To keep things conservative we only split
 * when the resulting halves are both at least 3 chars.
 */
export function compoundTokenVariants(address: string): string[] {
  const out: string[] = [];
  const tokens = address.trim().split(/\s+/);
  if (tokens.length === 0) return out;
  // Splits: for each interior token, attempt a split.
  for (let i = 0; i < tokens.length; i++) {
    for (const split of splitCompoundToken(tokens[i])) {
      const next = [...tokens.slice(0, i), split, ...tokens.slice(i + 1)].join(' ');
      out.push(next);
    }
  }
  // Joins: only emit a join when the first half is a recognized
  // compound prefix ("Blue", "Pine", "Oak", ...). This avoids
  // hallucinating "HiddenCove" or "RidgeRunner" style merges that
  // never appear as a real Zillow address.
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (
      isJoinableToken(a) &&
      isJoinableToken(b) &&
      COMPOUND_PREFIXES.includes(a.toLowerCase())
    ) {
      const joined = a + b;
      const next = [
        ...tokens.slice(0, i),
        joined,
        ...tokens.slice(i + 2),
      ].join(' ');
      out.push(next);
    }
  }
  return out;
}

// Known prefix words that frequently appear as the first half of a
// compound street name in the markets this resolver targets (Lake
// Lure / mountain-NC). Used to suggest a split when the heuristic
// CamelCase boundary doesn't fire.
const COMPOUND_PREFIXES = [
  'blue',
  'pine',
  'oak',
  'red',
  'white',
  'black',
  'green',
  'high',
  'long',
  'old',
  'new',
  'silver',
  'gold',
  'sun',
  'moon',
  'stone',
  'lake',
  'river',
  'mountain',
  'rock',
  'fox',
  'deer',
  'wolf',
  'bear',
  'eagle',
  'hawk',
];

function splitCompoundToken(token: string): string[] {
  const out: string[] = [];
  if (token.length < 6 || !/^[A-Za-z]+$/.test(token)) return out;
  // CamelCase split.
  const camel = /^([A-Z][a-z]+)([A-Z][a-z]+)$/.exec(token);
  if (camel) {
    out.push(`${camel[1]} ${camel[2]}`);
  }
  // Known-prefix split.
  const lower = token.toLowerCase();
  for (const pref of COMPOUND_PREFIXES) {
    if (lower.startsWith(pref) && lower.length - pref.length >= 3) {
      const head = token.slice(0, pref.length);
      const tail = token.slice(pref.length);
      // Title-case tail if the original was capitalized.
      const tailOut =
        token[0] === token[0].toUpperCase()
          ? tail.charAt(0).toUpperCase() + tail.slice(1)
          : tail;
      const split = `${head} ${tailOut}`;
      if (!out.includes(split)) out.push(split);
    }
  }
  return out;
}

function isJoinableToken(token: string): boolean {
  if (token.length < 3) return false;
  if (!/^[A-Za-z]+$/.test(token)) return false;
  // Don't join across a recognized street suffix — "Cove Rd" must stay split.
  const lower = token.toLowerCase();
  if (SUFFIX_EXPANSIONS[lower] || SUFFIX_CONTRACTIONS[lower]) return false;
  return true;
}

/**
 * Run the full 3-rung ladder against a single address. Returns the
 * first hit (with `via` marking which rung produced it) or null when
 * all three miss. Throws on transport errors — callers in the bulk
 * path wrap this in per-row error capture.
 */
export async function resolveAddressFull(
  client: ZillowClient,
  input: ResolverInput
): Promise<{ hit: ResolverHit; finalSlug: string } | { miss: ResolverMiss }> {
  const baseSlug = buildAddressSlug(input);

  // Rung 1: direct.
  const direct = await resolveDirect(client, baseSlug);
  if (direct) {
    return {
      hit: {
        raw: direct.raw,
        formatted: direct.formatted,
        via: 'direct',
        slug: baseSlug,
      },
      finalSlug: baseSlug,
    };
  }

  // Rung 2: suffix expansion + compound-token variants (issue #51 + #76).
  const variants = streetAddressVariants(input.address).slice(1); // skip original
  for (const v of variants) {
    const slug = buildAddressSlug({ ...input, address: v });
    const hit = await resolveDirect(client, slug);
    if (hit) {
      return {
        hit: {
          raw: hit.raw,
          formatted: hit.formatted,
          via: 'suffix_expansion',
          slug,
        },
        finalSlug: slug,
      };
    }
  }

  // Rung 3: search fallback (issue #52 / #74).
  const fallbackHit = await searchFallback(client, input);
  if (fallbackHit) {
    const formatted = formatListing(fallbackHit);
    if (formatted) {
      return {
        hit: {
          raw: fallbackHit,
          formatted,
          via: 'search_fallback',
          slug: baseSlug,
        },
        finalSlug: baseSlug,
      };
    }
  }

  return { miss: { slug: baseSlug } };
}
