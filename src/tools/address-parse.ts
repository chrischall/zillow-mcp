/**
 * Free-text address parser used by the bulk resolver to split a string
 * like `"126 Sleeping Bear Ln, Lake Lure, NC 28746"` into
 * `{address, city, state, zip}` so it can feed the shared 3-rung
 * resolver with the same shape the single tool already takes.
 *
 * Heuristic-only — comma-separated parts feed `[street, city, state+zip]`.
 * When the input doesn't follow that shape we return `{address: input}`
 * and let the resolver fall through to its scope-less rungs.
 */

export interface ParsedAddress {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
}

const STATE_ZIP_RE = /^([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/;
const ZIP_ONLY_RE = /^(\d{5}(?:-\d{4})?)$/;

export function parseFreeTextAddress(input: string): ParsedAddress {
  const raw = input.trim();
  if (!raw) return { address: '' };
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length <= 1) return { address: raw };

  // Last part may be "STATE ZIP", "STATE", or "ZIP" alone.
  const last = parts[parts.length - 1];
  let state: string | undefined;
  let zip: string | undefined;
  let cityIdx = parts.length - 2;

  const m = STATE_ZIP_RE.exec(last);
  if (m) {
    state = m[1].toUpperCase();
    zip = m[2];
  } else if (ZIP_ONLY_RE.test(last)) {
    zip = last;
    // Look one further back for a "STATE" alone.
    if (parts.length >= 3) {
      const prev = parts[parts.length - 2];
      const sm = /^([A-Za-z]{2})$/.exec(prev);
      if (sm) {
        state = sm[1].toUpperCase();
        cityIdx = parts.length - 3;
      }
    }
  } else {
    // Last part isn't state/zip — treat it as the city.
    cityIdx = parts.length - 1;
  }
  const street = parts.slice(0, Math.max(1, cityIdx)).join(', ');
  const city = cityIdx >= 1 && cityIdx < parts.length ? parts[cityIdx] : undefined;
  const out: ParsedAddress = { address: street };
  if (city) out.city = city;
  if (state) out.state = state;
  if (zip) out.zip = zip;
  return out;
}
