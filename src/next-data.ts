/**
 * Extract Next.js hydration data from a Zillow HTML page.
 *
 * Zillow is a Next.js app. Every SSR-rendered page embeds the full page
 * state as a JSON blob inside a `<script id="__NEXT_DATA__" type="application/json">`
 * tag. This is far easier (and more stable) than the JSON APIs, which
 * change without notice.
 *
 * The script tag has predictable boundaries — the body is straight JSON,
 * no JS-assignment shenanigans.
 */

import { extractNextDataText } from '@chrischall/mcp-utils/scrape';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Parse the page's `__NEXT_DATA__` blob.
 *
 * The tag scan is mcp-utils' `extractNextDataText` (fleet-audit#1145): one
 * linear, tag-bounded `indexOf` pass. The previous
 * `/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>/i` regex backtracked
 * quadratically over a page of repeated `<script ` openers with the `>`
 * withheld, stalling the whole stdio server on a hostile response.
 *
 * Kept local (rather than calling `extractNextData`, which returns
 * `undefined` for every failure) so the two failure modes stay distinct
 * `ParseError` messages: "tag not found" vs "invalid JSON".
 */
export function extractNextData(html: string): Record<string, unknown> {
  const json = extractNextDataText(html);
  if (json === undefined) {
    throw new ParseError(
      '__NEXT_DATA__ script tag not found in HTML (or unterminated / oversized)'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ParseError(
      `Failed to parse __NEXT_DATA__ JSON: ${(err as Error).message}`
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ParseError('__NEXT_DATA__ JSON is not an object');
  }
  return parsed as Record<string, unknown>;
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
