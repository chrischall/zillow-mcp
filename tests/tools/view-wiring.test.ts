import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { createTestHarness } from '../helpers.js';

/**
 * Structural coverage for the `view` wiring across all three read tools
 * (#225, the "Important" finding).
 *
 * WHY A SPY AND NOT AN OUTPUT ASSERTION. The defect was that
 * `zillow_search_properties`' filtered/paginated branch — the primary path —
 * returned a bare `minifiedResult` and never consulted the `view` it
 * declared. But a `FormattedListing`'s only media field is the constructed
 * `image_url`, which `view.ts` KEEPS on purpose (#119), so compact and full
 * currently serialize to the same bytes: reverting the fix changes NO output,
 * and a black-box test cannot tell the two apart. (Verified by mutation —
 * restoring `minifiedResult` there leaves every output test in
 * `search.test.ts` green.)
 *
 * The contract that broke is therefore "the declared parameter reaches the
 * response builder", and that is what these assert. It is the difference
 * between a parameter that happens to be a no-op on today's payload and one
 * that is ignored — the second stays broken when a media field is added, and
 * reads as honoured the whole time.
 *
 * The spy delegates to the real `viewResponse`, so behaviour is untouched;
 * only the call is observed.
 */
const seenViews: Array<string | undefined> = [];

vi.mock('../../src/view.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/view.js')>();
  return {
    ...actual,
    viewResponse: (view: string | undefined, data: unknown) => {
      seenViews.push(view);
      return actual.viewResponse(view, data);
    },
  };
});

const { registerSearchTools } = await import('../../src/tools/search.js');
const { registerGetByAddressTools } = await import(
  '../../src/tools/get-by-address.js'
);
const { registerResolveAddressesTools } = await import(
  '../../src/tools/resolve-addresses.js'
);

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as ZillowClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  vi.clearAllMocks();
  seenViews.length = 0;
});
afterAll(async () => {
  if (harness) await harness.close();
});

/**
 * A search-page response holding one Lake Lure listing — enough for the
 * resolver's location guard to pass on any "Lake Lure" query.
 */
function htmlWithListings(args: {
  regionSelection?: Array<{ regionId: number; regionType: number }>;
  mapBounds?: { north: number; south: number; east: number; west: number };
  zpids?: number[];
}): string {
  const listResults = (args.zpids ?? [1]).map((zpid) => ({
    zpid,
    detailUrl: `/homedetails/x/${zpid}_zpid/`,
    imgSrc: `https://photos.zillowstatic.com/fp/${zpid}.jpg`,
    hdpData: {
      homeInfo: {
        zpid,
        streetAddress: `${zpid} Wambli Pass`,
        city: 'Lake Lure',
        state: 'NC',
        zipcode: '28746',
      },
    },
  }));
  const nextData = {
    props: {
      pageProps: {
        searchPageState: {
          queryState: {
            regionSelection: args.regionSelection,
            mapBounds: args.mapBounds,
          },
          cat1: { searchResults: { listResults } },
        },
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script>`;
}

const REGION = {
  regionSelection: [{ regionId: 70190, regionType: 7 }],
  mapBounds: { north: 36, south: 35, east: -82, west: -82.5 },
};

describe('view wiring across the read tools (#225)', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerSearchTools(server, mockClient);
      registerGetByAddressTools(server, mockClient);
      registerResolveAddressesTools(server, mockClient);
    });
  });

  it('zillow_search_properties: the filtered branch answers in the requested rung', async () => {
    // The regression itself. A region resolves, so step 2 runs and the
    // aggregated result is what comes back — the branch that used to skip
    // `viewResponse` entirely. Exactly one call, carrying the caller's rung.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithListings({ ...REGION, zpids: [1] })
    );
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithListings({ ...REGION, zpids: [11, 12] })
    );
    await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC 28746',
      view: 'full',
    });
    // Two fetches — resolve then filter — confirms we took the filtered
    // branch and not the single-round-trip address path.
    expect(mockFetchHtml).toHaveBeenCalledTimes(2);
    expect(seenViews).toEqual(['full']);
  });

  it('zillow_search_properties: an omitted view reaches the branch as undefined', async () => {
    // `viewResponse` is what turns "absent" into compact. The handler must
    // pass the absence along rather than substituting a rung of its own —
    // otherwise the default lives in two places and they can drift.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithListings({ ...REGION, zpids: [1] })
    );
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithListings({ ...REGION, zpids: [21] })
    );
    await harness.callTool('zillow_search_properties', {
      location: 'Lake Lure, NC 28746',
    });
    expect(seenViews).toEqual([undefined]);
  });

  it('zillow_search_properties: the single-round-trip address branch too', async () => {
    // No region pinned, so the resolver's listings are surfaced directly.
    // This branch already honoured `view`; pinning it keeps the two paths
    // from drifting apart again.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithListings({ regionSelection: [], zpids: [31] })
    );
    await harness.callTool('zillow_search_properties', {
      location: 'Wambli Pass Lake Lure NC',
      view: 'full',
    });
    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    expect(seenViews).toEqual(['full']);
  });

  it('zillow_get_by_address: the resolved hit answers in the requested rung', async () => {
    mockFetchHtml.mockResolvedValue(
      htmlWithListings({ regionSelection: [], zpids: [41] })
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '41 Wambli Pass',
      city: 'Lake Lure',
      state: 'NC',
      view: 'full',
    });
    expect(result.isError).toBeFalsy();
    expect(seenViews).toEqual(['full']);
  });

  it('zillow_get_by_address: the MISS path answers in the requested rung too', async () => {
    // `{ resolved: false }` is a real answer, not an error, so it goes
    // through the same rung as a hit — a refusal that skipped the formatter
    // would come back shaped differently from every other response.
    mockFetchHtml.mockResolvedValue(
      htmlWithListings({ regionSelection: [], zpids: [] })
    );
    const result = await harness.callTool('zillow_get_by_address', {
      address: '999 Nowhere Rd',
      city: 'Lake Lure',
      state: 'NC',
      view: 'compact',
    });
    expect(result.isError).toBeFalsy();
    expect(seenViews).toEqual(['compact']);
  });

  it('zillow_resolve_addresses: the batch envelope answers in the requested rung', async () => {
    // This one destructured `view` correctly from the start (it is the
    // consistency model the other two were brought in line with), so this
    // guards it rather than fixing it.
    mockFetchHtml.mockResolvedValue(
      htmlWithListings({ regionSelection: [], zpids: [51] })
    );
    const result = await harness.callTool('zillow_resolve_addresses', {
      addresses: ['51 Wambli Pass, Lake Lure, NC'],
      view: 'full',
    });
    expect(result.isError).toBeFalsy();
    // One envelope for the whole batch — the rung is applied once, to the
    // envelope, not per row.
    expect(seenViews).toEqual(['full']);
  });

  it('zillow_get_property_photos declares no view at all', async () => {
    // The tool whose PRODUCT is the image. Stripping media there does not
    // shrink the response, it empties it — so it must not offer the rung,
    // not merely default it to `full`. The tool's own name is the test.
    const { tools } = await harness.client.listTools();
    const photos = tools.find((t) => t.name === 'zillow_get_property_photos');
    expect(photos).toBeUndefined(); // not registered on this harness
    // Registered on its own, it still declares no `view`.
    const own = await createTestHarness(async (server) => {
      const { registerPhotosTools } = await import('../../src/tools/photos.js');
      registerPhotosTools(server, mockClient);
    });
    const listed = await own.client.listTools();
    const tool = listed.tools.find(
      (t) => t.name === 'zillow_get_property_photos'
    );
    expect(tool).toBeDefined();
    expect(
      (tool!.inputSchema as { properties?: Record<string, unknown> }).properties
    ).not.toHaveProperty('view');
    await own.close();
  });
});
