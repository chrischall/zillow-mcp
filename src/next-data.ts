/**
 * Extract Next.js hydration data from a Zillow HTML page.
 *
 * Zillow is a Next.js app. Every SSR-rendered page embeds the full page
 * state as a JSON blob inside a `<script id="__NEXT_DATA__" type="application/json">`
 * tag. This is far easier (and more stable) than the JSON APIs, which
 * change without notice.
 *
 * The script tag has predictable boundaries — the body is straight JSON,
 * no JS-assignment shenanigans — so a simple find-the-close-tag
 * extractor works.
 */

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const OPEN_TAG_RE =
  /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>/i;
const CLOSE_TAG = '</script>';

export function extractNextData(html: string): Record<string, unknown> {
  const openMatch = OPEN_TAG_RE.exec(html);
  if (!openMatch) {
    throw new ParseError('__NEXT_DATA__ script tag not found in HTML');
  }
  const start = openMatch.index + openMatch[0].length;
  const end = html.indexOf(CLOSE_TAG, start);
  if (end < 0) {
    throw new ParseError('__NEXT_DATA__ script tag has no closing </script>');
  }
  const json = html.slice(start, end).trim();
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new ParseError(
      `Failed to parse __NEXT_DATA__ JSON: ${(err as Error).message}`
    );
  }
}

/**
 * Convenience: drill into `props.pageProps` from the parsed __NEXT_DATA__.
 * This is where Zillow puts the per-page state.
 */
export function getPageProps(nextData: Record<string, unknown>): Record<string, unknown> {
  const props = nextData.props as Record<string, unknown> | undefined;
  const pageProps = props?.pageProps as Record<string, unknown> | undefined;
  return pageProps ?? {};
}
