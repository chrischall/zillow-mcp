import { describe, it, expect, vi } from 'vitest';
import type { ZillowClient } from '../../src/client.js';
import { searchFallback } from '../../src/tools/resolver.js';

// fleet-audit#287: the search-fallback rung must anchor on the house
// number (realty-core `addressMatch`), not substring-match the street
// tokens — otherwise "12 Main St" resolves "1234 Main St" and "126 Oak
// Dr" resolves "1260 Oak Dr".

function listing(zpid: number, streetAddress: string) {
  return {
    zpid,
    detailUrl: `/homedetails/${zpid}_zpid/`,
    address: `${streetAddress}, Lake Lure, NC 28746`,
    hdpData: {
      homeInfo: { zpid, streetAddress, city: 'Lake Lure', state: 'NC', zipcode: '28746' },
    },
  };
}

function clientReturning(listings: unknown[]): ZillowClient {
  // No region pinned + city-matching listings → resolveLocationOrListings
  // hands the listings straight to the fallback matcher.
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        searchPageState: {
          queryState: { regionSelection: [], mapBounds: null },
          cat1: { searchResults: { listResults: listings } },
        },
      },
    },
  })}</script>`;
  return { fetchHtml: vi.fn().mockResolvedValue(html) } as unknown as ZillowClient;
}

const scope = { city: 'Lake Lure', state: 'NC' };

describe('searchFallback house-number anchoring (fleet-audit#287)', () => {
  it('does not resolve a 2-digit house number to a different house on the same street', async () => {
    const client = clientReturning([listing(1, '1234 Main St')]);
    expect(await searchFallback(client, { address: '12 Main St', ...scope })).toBeNull();
  });

  it('does not substring-match 126 against 1260 or 2126', async () => {
    const client = clientReturning([listing(1, '1260 Oak Dr'), listing(2, '2126 Oak Dr')]);
    expect(await searchFallback(client, { address: '126 Oak Dr', ...scope })).toBeNull();
  });

  it('picks the listing whose house number matches, skipping near-misses', async () => {
    const client = clientReturning([
      listing(1, '1234 Main St'),
      listing(2, '12 Main St'),
    ]);
    const hit = await searchFallback(client, { address: '12 Main St', ...scope });
    expect(hit?.zpid).toBe(2);
  });

  it('still accepts an exact street match with a 3+ digit number', async () => {
    const client = clientReturning([listing(1, '1260 Oak Dr'), listing(2, '126 Oak Dr')]);
    const hit = await searchFallback(client, { address: '126 Oak Dr', ...scope });
    expect(hit?.zpid).toBe(2);
  });
});
