/**
 * Community vocabulary resolution for Zillow listing-feature extraction.
 *
 * The keyword extraction itself (`extractFeatures` / `ExtractedFeatures`)
 * now lives in `@chrischall/realty-core` — the canonical, dependency-free
 * helper reconciling the five cohort implementations. This module keeps
 * the one piece that cannot move there: `loadCommunities`, which does
 * filesystem I/O (reads a JSON file named by `ZILLOW_COMMUNITIES_FILE`)
 * and would break realty-core's no-I/O invariant. The resolved list is
 * passed into the canonical `extractFeatures` by the caller.
 */

import { existsSync, readFileSync } from 'node:fs';

export { extractFeatures } from '@chrischall/realty-core';
export type { ExtractedFeatures } from '@chrischall/realty-core';

/**
 * Default community vocabulary for the Lake Lure / mountain-NC market
 * (this project was bootstrapped against that market). Users in other
 * markets can override via the `ZILLOW_COMMUNITIES_FILE` env var (JSON
 * file containing a string array) — see `loadCommunities`.
 */
export const DEFAULT_COMMUNITIES: string[] = [
  'Rumbling Bald',
  'Riverbend at Lake Lure',
  'The Lodges at Eagles Nest',
  'Hunters Ridge',
  'Beech Mountain Club',
  'The Cliffs',
  'Pinnacle Ridge',
  'Highland Heights',
  'Shelter Rock',
  'Charter Hills',
];

let cachedCommunities: string[] | null = null;
let cachedPath: string | null = null;
// Negative cache: remembers a path we've already failed to load from so
// we don't re-stat / re-read the filesystem on every call when the
// configured file is missing or malformed (PR #61 polish nit). Cleared
// whenever the env-var path changes or is unset, so a misconfiguration
// can be corrected by updating ZILLOW_COMMUNITIES_FILE.
let cachedFailurePath: string | null = null;

/**
 * Resolve the active community vocabulary. Reads `ZILLOW_COMMUNITIES_FILE`
 * (expects a JSON string array). Falls back to `DEFAULT_COMMUNITIES`
 * when unset, the file is missing, or the JSON is malformed (with a
 * stderr warning so misconfiguration is visible). Cached per process
 * keyed by the env-var value — both the positive AND negative result.
 */
export function loadCommunities(): string[] {
  const path = process.env.ZILLOW_COMMUNITIES_FILE?.trim();
  if (!path) {
    cachedCommunities = null;
    cachedPath = null;
    cachedFailurePath = null;
    return DEFAULT_COMMUNITIES;
  }
  if (cachedCommunities && cachedPath === path) {
    return cachedCommunities;
  }
  if (cachedFailurePath === path) {
    // Already tried this path and it failed — keep serving the default
    // until the env-var changes. Avoids re-statting / re-reading the
    // disk on every extraction call in a high-volume session.
    return DEFAULT_COMMUNITIES;
  }
  // Path changed since the last call — drop any stale positive cache.
  cachedCommunities = null;
  cachedPath = null;
  if (!existsSync(path)) {
    console.error(
      `[zillow-mcp] ZILLOW_COMMUNITIES_FILE="${path}" not found — falling back to DEFAULT_COMMUNITIES.`
    );
    cachedFailurePath = path;
    return DEFAULT_COMMUNITIES;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
      console.error(
        `[zillow-mcp] ZILLOW_COMMUNITIES_FILE="${path}" must be a JSON string array — falling back to DEFAULT_COMMUNITIES.`
      );
      cachedFailurePath = path;
      return DEFAULT_COMMUNITIES;
    }
    cachedCommunities = parsed;
    cachedPath = path;
    cachedFailurePath = null;
    return cachedCommunities;
  } catch (err) {
    console.error(
      `[zillow-mcp] failed to load ZILLOW_COMMUNITIES_FILE="${path}": ${
        err instanceof Error ? err.message : String(err)
      } — falling back to DEFAULT_COMMUNITIES.`
    );
    cachedFailurePath = path;
    return DEFAULT_COMMUNITIES;
  }
}
