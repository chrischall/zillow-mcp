import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import {
  formatPhoto,
  largestJpeg,
  registerPhotosTools,
} from '../../src/tools/photos.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
// `fetchPropertyRecord` tries GraphQL first (issue #99); these tests
// cover the SSR scrape, so `fetchJson` is stubbed to reject → fall back.
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  vi.clearAllMocks();
  mockFetchJson.mockRejectedValue(new Error('graphql disabled in this test'));
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('largestJpeg', () => {
  it('returns the widest entry by width', () => {
    expect(
      largestJpeg([
        { url: 'https://a/200.jpg', width: 200 },
        { url: 'https://a/1500.jpg', width: 1500 },
        { url: 'https://a/800.jpg', width: 800 },
      ])
    ).toBe('https://a/1500.jpg');
  });

  it('returns undefined for empty / undefined input', () => {
    expect(largestJpeg(undefined)).toBeUndefined();
    expect(largestJpeg([])).toBeUndefined();
  });
});

describe('formatPhoto', () => {
  const raw = {
    caption: 'Living room',
    subjectType: 'INTERIOR',
    url: 'https://photos.zillowstatic.com/fp/abc-p_d.jpg',
    mixedSources: {
      jpeg: [
        { url: 'https://a/192.jpg', width: 192 },
        { url: 'https://a/1536.jpg', width: 1536 },
      ],
      webp: [
        { url: 'https://a/192.webp', width: 192 },
        { url: 'https://a/1536.webp', width: 1536 },
      ],
    },
  };

  it('omits the multi-width source lists by default (size budget)', () => {
    const out = formatPhoto(raw);
    expect(out).toEqual({
      url: 'https://photos.zillowstatic.com/fp/abc-p_d.jpg',
      url_large: 'https://a/1536.jpg',
      url_large_webp: 'https://a/1536.webp',
      caption: 'Living room',
      subject_type: 'INTERIOR',
    });
  });

  it('includes the multi-width source lists when include_sources=true', () => {
    const out = formatPhoto(raw, true);
    expect(out?.jpeg_sources).toEqual(raw.mixedSources.jpeg);
    expect(out?.webp_sources).toEqual(raw.mixedSources.webp);
  });

  it('returns null when the photo has no url and no sources', () => {
    expect(formatPhoto({})).toBeNull();
  });

  it('falls back to the bare url when mixedSources is absent', () => {
    const out = formatPhoto({ url: 'https://a/p_d.jpg' });
    expect(out).toEqual({ url: 'https://a/p_d.jpg' });
  });
});

describe('zillow_get_property_photos tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerPhotosTools(server, mockClient)
    );
  });

  const photosHtmlFor = (photos: unknown[]) => {
    const cache = JSON.stringify({
      'Property:1': { property: { zpid: 1, photos, photoCount: photos.length } },
    });
    const nextData = {
      props: { pageProps: { gdpClientCache: cache } },
    };
    return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      nextData
    )}</script></html>`;
  };

  it('fetches the homedetails page and returns the full gallery', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      photosHtmlFor([
        { url: 'https://a/1.jpg', caption: 'Front' },
        { url: 'https://a/2.jpg', caption: 'Kitchen' },
      ])
    );
    const r = await harness.callTool('zillow_get_property_photos', { zpid: 1 });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/homedetails/1_zpid/');

    const parsed = parseToolResult<{
      zpid: string;
      count: number;
      photos: Array<{ url: string }>;
    }>(r);
    expect(parsed.zpid).toBe('1');
    expect(parsed.count).toBe(2);
    expect(parsed.photos.map((p) => p.url)).toEqual([
      'https://a/1.jpg',
      'https://a/2.jpg',
    ]);
  });

  it('returns count=0 when the property has no photos', async () => {
    mockFetchHtml.mockResolvedValueOnce(photosHtmlFor([]));
    const r = await harness.callTool('zillow_get_property_photos', { zpid: 5 });
    const parsed = parseToolResult<{ count: number; photos: unknown[] }>(r);
    expect(parsed.count).toBe(0);
    expect(parsed.photos).toEqual([]);
  });
});
