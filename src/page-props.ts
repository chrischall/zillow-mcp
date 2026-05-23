/**
 * Helpers for navigating Zillow's __NEXT_DATA__.props.pageProps blob.
 *
 * Zillow ships several variants of the same data shape between
 * deployments (e.g. `savedSearches` → `userSavedSearches`,
 * `gdpClientCache` → `componentProps.gdpClientCache`). Tools defend
 * against this with two tactics:
 *
 *   1. Check well-known direct field names first.
 *   2. If none match, walk every array in pageProps and pick the first
 *      one whose first element matches a shape predicate.
 *
 * Both tactics are wrapped here so saved.ts (which uses them twice)
 * and any future per-page tool can share the same implementation.
 */

/**
 * Locate an array in pageProps. Looks at each name in `directKeys` in
 * order; the first one that is an array is returned. If none match,
 * walks every value in pageProps and returns the first array whose
 * first element passes the `shapeMatches` predicate. Returns `[]` if
 * nothing matches — callers can treat "empty list" and "shape not
 * found" the same way (an empty result is more useful than a thrown
 * error in this domain).
 */
export function findArrayByShape<T>(
  pageProps: Record<string, unknown>,
  directKeys: readonly string[],
  shapeMatches: (firstElement: object) => boolean
): T[] {
  for (const key of directKeys) {
    const candidate = pageProps[key];
    if (Array.isArray(candidate)) return candidate as T[];
  }
  for (const v of Object.values(pageProps)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === 'object' &&
      v[0] !== null &&
      shapeMatches(v[0] as object)
    ) {
      return v as T[];
    }
  }
  return [];
}
