/**
 * Transparency note for an empty history/series result (Bug #1). Zillow
 * omits these series from the server-rendered payload for many listings
 * (the lean non-Showcase `ForSalePriorityQuery` shape) and loads them
 * client-side, so an empty result is ambiguous. Distinguishes
 * `sourcePresent: false` (field absent — not server-rendered, not a real
 * zero) from `sourcePresent: true` (present but empty — genuinely none).
 * Returns `undefined` when the series has data.
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
