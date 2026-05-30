/**
 * Transparency note for the history/series tools (Bug #1).
 *
 * Zillow renders a listing's detailed series (Zestimate trend, price
 * history, tax history) CLIENT-SIDE for many listings and omits them from
 * the server-rendered `__NEXT_DATA__` payload — notably the lean
 * `ForSalePriorityQuery` shape that non-"Showcase" listings get. The
 * scalar facts (current Zestimate, price, etc.) are still present, so a
 * caller sees a property that clearly HAS a Zestimate yet gets an empty
 * history series, with no way to tell "the tool can't see it" from
 * "the property genuinely has none".
 *
 * This builds a one-line note that distinguishes the two:
 *   - `sourcePresent: false` (the field was ABSENT from the SSR property)
 *     → the data isn't server-rendered for this listing; not a real zero.
 *   - `sourcePresent: true` (the field was present but empty)
 *     → the property genuinely has none on record.
 * Returns `undefined` when the series is non-empty (no note needed).
 */
export function seriesAvailabilityNote(args: {
  empty: boolean;
  sourcePresent: boolean;
  kind: string;
}): string | undefined {
  if (!args.empty) return undefined;
  if (args.sourcePresent) {
    return `Zillow has no ${args.kind} on record for this property.`;
  }
  return (
    `No ${args.kind} in Zillow's server-rendered page for this listing. ` +
    `Zillow loads it client-side and omits it from the SSR payload for some ` +
    `listings (commonly non-Showcase), so it isn't available through this tool — ` +
    `this is NOT a confirmed zero. Scalar fields from zillow_get_property ` +
    `(e.g. the current Zestimate) are unaffected.`
  );
}
