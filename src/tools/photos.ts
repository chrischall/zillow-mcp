import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZillowClient } from '../client.js';
import { textResult } from '../mcp.js';
import { fetchPropertyRecord } from './properties.js';

/**
 * Zillow embeds the full photo gallery for a property inside the
 * homedetails page's `__NEXT_DATA__` cache (the same one we already mine
 * for property facts). The relevant fields:
 *
 *   - `property.photos[]` and `property.responsivePhotos[]` carry the
 *     gallery, identical shape in practice. Each entry has:
 *       { caption, subjectType, url, mixedSources: { jpeg, webp } }
 *     where `mixedSources.{jpeg,webp}` is a list of `{url, width}`
 *     entries from ~192px up to ~1536px wide.
 *   - `property.originalPhotos[]` is older shape, larger but slower to
 *     load. We surface `photos[]` first, fall back to either of the
 *     others, and stop there — same image set in all three.
 *
 * Verified live 2026-05-23 against /homedetails/1628-W-8th-St-... (54
 * photos in `photos[]`, identical count in `responsivePhotos[]`).
 */

export interface MixedSourceEntry {
  url?: string;
  width?: number;
}

export interface RawPhoto {
  caption?: string;
  subjectType?: string;
  url?: string;
  mixedSources?: {
    jpeg?: MixedSourceEntry[];
    webp?: MixedSourceEntry[];
  };
}

export interface FormattedPhoto {
  url?: string;
  url_large?: string;
  url_large_webp?: string;
  caption?: string;
  subject_type?: string;
  jpeg_sources?: MixedSourceEntry[];
  webp_sources?: MixedSourceEntry[];
}

/**
 * Return the URL of the widest entry in a mixedSources list, or
 * undefined if the list is empty / undefined. Width-based selection
 * avoids relying on list order, which has flipped between deploys.
 */
export function largestJpeg(
  sources: MixedSourceEntry[] | undefined
): string | undefined {
  if (!sources || sources.length === 0) return undefined;
  let best: MixedSourceEntry | undefined;
  for (const s of sources) {
    if (!s.url) continue;
    if (!best || (s.width ?? 0) > (best.width ?? 0)) best = s;
  }
  return best?.url;
}

export function formatPhoto(p: RawPhoto): FormattedPhoto | null {
  const mixed = p.mixedSources;
  const url = p.url;
  if (!url && !mixed?.jpeg?.length && !mixed?.webp?.length) return null;
  const out: FormattedPhoto = {};
  if (url) out.url = url;
  const largeJpeg = largestJpeg(mixed?.jpeg);
  const largeWebp = largestJpeg(mixed?.webp);
  if (largeJpeg) out.url_large = largeJpeg;
  if (largeWebp) out.url_large_webp = largeWebp;
  if (p.caption) out.caption = p.caption;
  if (p.subjectType) out.subject_type = p.subjectType;
  if (mixed?.jpeg?.length) out.jpeg_sources = mixed.jpeg;
  if (mixed?.webp?.length) out.webp_sources = mixed.webp;
  return out;
}

interface PropertyWithPhotos {
  zpid?: number | string;
  photos?: RawPhoto[];
  responsivePhotos?: RawPhoto[];
  originalPhotos?: RawPhoto[];
  photoCount?: number;
  streetViewImageUrl?: string;
  hiResImageLink?: string;
}

/**
 * Pick whichever of the three photo arrays is populated. They carry
 * identical galleries in practice — `photos` is preferred since it's
 * what Zillow's own web UI hydrates from, `responsivePhotos` is a near-
 * exact alias, and `originalPhotos` is the legacy fallback.
 */
function pickPhotoArray(p: PropertyWithPhotos): RawPhoto[] {
  if (Array.isArray(p.photos) && p.photos.length > 0) return p.photos;
  if (Array.isArray(p.responsivePhotos) && p.responsivePhotos.length > 0)
    return p.responsivePhotos;
  if (Array.isArray(p.originalPhotos) && p.originalPhotos.length > 0)
    return p.originalPhotos;
  return [];
}

export function registerPhotosTools(
  server: McpServer,
  client: ZillowClient
): void {
  server.registerTool(
    'zillow_get_property_photos',
    {
      title: 'Get Zillow property photo gallery',
      description:
        "The full photo gallery for a Zillow property — every image embedded in the homedetails page. Each entry returns the canonical hero URL plus a multi-width source list (jpeg + webp variants from ~192px up to ~1536px), caption when present, and subject type (e.g. INTERIOR, EXTERIOR). Provide exactly one of `zpid` or `url`. Returns `{ zpid, count, photos, street_view_url?, high_res_url? }`. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Zillow property photo gallery',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        zpid: z
          .union([z.number().int().positive(), z.string()])
          .optional()
          .describe('Zillow Property ID (numeric)'),
        url: z
          .string()
          .optional()
          .describe('A Zillow homedetails URL (or path beginning with /homedetails/)'),
      },
    },
    async ({ zpid, url }) => {
      const { raw } = await fetchPropertyRecord(client, { zpid, url });
      const p = raw as PropertyWithPhotos;
      const rawPhotos = pickPhotoArray(p);
      const photos = rawPhotos
        .map(formatPhoto)
        .filter((x): x is FormattedPhoto => x !== null);
      const zpidStr = String(raw.zpid ?? zpid ?? '');
      return textResult({
        zpid: zpidStr,
        count: photos.length,
        photos,
        street_view_url: p.streetViewImageUrl,
        high_res_url: p.hiResImageLink,
      });
    }
  );
}
