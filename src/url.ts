/**
 * Small URL helpers shared across tools.
 *
 * Zillow's pages are served from a fixed `https://www.zillow.com` origin
 * and the FetchproxyTransport prepends that for us — tools work in terms
 * of paths, not URLs. When a tool accepts a `url` arg from the user, we
 * need to reduce it down to a path before handing it off.
 *
 * `urlToPath` was byte-identical across the cohort, so it now lives in
 * `@chrischall/realty-core` (cohort migration realty-mcp#1). Re-exported
 * here so existing imports (`from '../url.js'`) keep working unchanged.
 */
export { urlToPath } from '@chrischall/realty-core';

/**
 * True when `path` (a urlToPath result) has a pathname under `prefix` and
 * no `.`/`..` segments, literal or percent-encoded — the browser would
 * normalise those and walk the credentialed GET out of `prefix`
 * (fleet-audit#814). Backslashes (literal or `%5c`) are rejected outright:
 * the WHATWG URL parser treats `\` as `/` for http(s), so `\..\` is a dot
 * segment too. As a final guard the pathname is resolved the way the
 * browser would (`new URL`) and the result must still sit under `prefix`.
 * Only the pathname is checked; the query string is not, so
 * `/user/acct?/home-values/` does not pass.
 */
export function isPathUnder(path: string, prefix: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  if (!pathname.startsWith(prefix)) return false;
  if (/\\|%5c/i.test(pathname)) return false;
  if (pathname.split('/').some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))) {
    return false;
  }
  return new URL(pathname, 'https://www.zillow.com').pathname.startsWith(
    prefix
  );
}
