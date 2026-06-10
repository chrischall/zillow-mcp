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
 *
 * The loader itself is now `@chrischall/mcp-utils`'
 * `createCachedJsonArrayLoader` — the shared, negative-caching env-named
 * JSON-string-array reader that replaces the `loadCommunities` /
 * `DEFAULT_COMMUNITIES` pattern previously quadruplicated across
 * redfin/zillow/homes/onehome (only the env var differs).
 */

import { createCachedJsonArrayLoader } from '@chrischall/mcp-utils';

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

/**
 * Resolve the active community vocabulary. Reads `ZILLOW_COMMUNITIES_FILE`
 * (expects a JSON string array). Falls back to `DEFAULT_COMMUNITIES`
 * when unset, the file is missing, or the JSON is malformed (with a
 * stderr warning so misconfiguration is visible). Cached per process
 * keyed by the env-var value — both the positive AND negative result.
 */
export const loadCommunities: () => string[] = createCachedJsonArrayLoader({
  envVar: 'ZILLOW_COMMUNITIES_FILE',
  defaults: DEFAULT_COMMUNITIES,
  label: 'zillow-mcp',
});
