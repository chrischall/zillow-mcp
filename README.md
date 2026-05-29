# zillow-mcp

Zillow real-estate access as an MCP server for Claude — search listings, fetch property details, Zestimate history, your saved searches & homes, and market reports via natural language.

> ⚠️ Zillow does not publish a public consumer API. The official [Bridge API](https://www.bridgeinteractive.com/developers/bridge-api/) is gated to MLS partners. This server uses the same private endpoints the zillow.com web app uses, routed through your own signed-in browser tab via the [fetchproxy](https://github.com/chrischall/fetchproxy) extension. Every request acts on behalf of your existing session — your cookies, your TLS, your JS context — exactly as if you'd clicked it in the browser yourself. Treat this as informal use of Zillow's website. Use at your own discretion.

## Why this exists

The four existing Zillow MCPs all sit on one of two foundations:

- The **Bridge API** — requires MLS membership, IDX vendor relationship, or "approved technology partnership" (10+ business-day approval). Consumers can't get in.
- A **paid scraper** (RapidAPI, Apify) — adds a third party to the trust path and rate-limits.

None of them can see what *you* have saved, favorited, or recently viewed — because both Bridge and third-party scrapers are out-of-session. zillow-mcp uses your already-signed-in zillow.com tab.

## Tools

| Tool | Purpose | Auth-scoped |
| --- | --- | :---: |
| `zillow_search_properties` | Search listings by location, status, price band, beds/baths, home type | |
| `zillow_get_property` | Full record for a zpid (price, Zestimate, beds, schools, neighborhood, price history) | |
| `zillow_get_by_address` | Resolve a free-text address (with optional city/state/zip) to its Zillow zpid + canonical URL | |
| `zillow_resolve_addresses` | Batch-resolve many free-text addresses (or structured rows) to zpids + canonical URLs | |
| `zillow_bulk_get` | Fetch full records for many zpids/URLs at once, with partial-result + bot-wall handling | |
| `zillow_get_property_photos` | Full photo gallery for a property — every image embedded in the homedetails page with multi-width jpeg + webp variants and captions | |
| `zillow_get_zestimate_history` | Time series of Zestimate values (and rent Zestimate where available) | |
| `zillow_get_price_history` | Listing history (Listed/Sold/Pending/etc.) with price + days on market | |
| `zillow_get_tax_history` | Annual tax-roll history — taxes paid and assessed value year-over-year | |
| `zillow_compare_properties` | Side-by-side comparison of up to 12 properties, with an aligned summary table | |
| `zillow_calculate_affordability` | Local affordability calculator — max purchase price from income/DTI/rates | |
| `zillow_estimate_rent_vs_buy` | Local rent-vs-buy break-even with appreciation + opportunity cost | |
| `zillow_get_saved_searches` | Your saved searches with new-listing counts and notification frequency | ✓ |
| `zillow_get_saved_homes` | Your favorited homes with current price + Zestimate + primary photo | ✓ |
| `zillow_get_market_report` | Median sale/list/rent, days on market, inventory, ZHVI for a region | |
| `zillow_calculate_mortgage` | Local PITI calculator — principal+interest, taxes, insurance, HOA, PMI (no network) | |
| `zillow_healthcheck` | Round-trip a public Zillow URL through the bridge to localize bridge/extension/Zillow-side failures | |
| `zillow_register_session` | Register a named Zillow session (bridge port) in the local session registry | |
| `zillow_set_active_session` | Switch which registered session subsequent tool calls route through | |
| `zillow_get_session_context` | Inspect the active session + the registered-session list | |

## Acknowledgement of Terms

By using this MCP server, you acknowledge and agree to the following:

**1. This server accesses your own Zillow session.** Every request is dispatched through your own browser tab (logged in or not) via the fetchproxy extension. It does not — and cannot — access anyone else's account.

**2. [Zillow's Terms of Use](https://www.zillow.com/z/corp/terms/) govern your use of this server**, just as they govern your direct use of zillow.com. The clauses most relevant here:

> You may not use any robot, spider, scraper or other automated means to access the Services for any purpose without our express written permission… nor may you conduct automated queries (including screen and database scraping, spiders, robots, crawlers, bypassing CAPTCHAs or similar precautions).

You are agreeing to those terms — read by the maintainer 2026-05-23 — every time you invoke a tool in this server. Zillow's terms broadly prohibit automated access without written permission; this is an unofficial tool and Zillow has not granted it permission.

**3. Personal, non-commercial use only.** This project is not affiliated with, endorsed by, sponsored by, or in partnership with Zillow Group. It is a personal automation tool that drives the same Zillow website you would drive by hand — one search at a time, your own saved homes, your own market reports. Do not use it to bulk-extract listings, train models, populate a competing real-estate product, or for any commercial purpose.

**4. Stability is not guaranteed.** This server reads private internal endpoints (`/async-create-search-page-state/`, `__NEXT_DATA__` blobs, `/myzillow/...`) that Zillow may change without notice. It may break. It may stop working. That's by design — the surface is not theirs to maintain on our behalf.

**5. You accept full responsibility** for any consequences of using this server in connection with your Zillow access — rate limiting, account warnings, suspension, IP blocks, captcha walls, or any enforcement action Zillow Group takes. If Zillow objects to your use, stop using this server.

This section is the maintainer's good-faith summary of the terms — it is not legal advice and does not modify or supersede Zillow's actual ToS.

## Install

### Option A — npx (after publishing)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "zillow": {
      "command": "npx",
      "args": ["-y", "zillow-mcp"]
    }
  }
}
```

### Option B — from source

```bash
git clone https://github.com/chrischall/zillow-mcp
cd zillow-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "zillow": {
      "command": "node",
      "args": ["/path/to/zillow-mcp/dist/bundle.js"]
    }
  }
}
```

### One-time browser setup

zillow-mcp talks to your browser through the [fetchproxy](https://github.com/chrischall/fetchproxy) extension, which is shared across every fetchproxy-based MCP (resy-mcp, opentable-mcp, …). Install it once:

```bash
git clone https://github.com/chrischall/fetchproxy
cd fetchproxy
npm ci
npm --workspace=@fetchproxy/extension-chrome run build
```

Then in Chrome: `chrome://extensions` → toggle Developer mode → Load unpacked → pick `packages/extension-chrome/dist/`.

Open zillow.com and sign in. That's all the auth this server needs.

## How it works

```
┌────────────────┐  stdio   ┌──────────────────┐   WS   ┌──────────────────┐    fetch()    ┌─────────────┐
│ MCP client     │◀────────▶│  dist/bundle.js  │◀──────▶│  fetchproxy      │◀────────────▶│ zillow.com  │
│ (Claude, etc.) │          │  (Zillow MCP)    │ :37149 │  extension       │   (real TLS, │ (your tab)  │
└────────────────┘          └──────────────────┘        │  (separate)      │   cookies)    └─────────────┘
```

The MCP server runs in Node, but every HTTP call to zillow.com is dispatched into your live browser tab through the fetchproxy extension. Each request rides your existing session — `_abck`, TLS fingerprint, and cookies all match the page that's already on screen. No headless browser stand-in, no separate identity, no third-party proxy: just your real browser, acting on its own behalf, with the MCP server picking what to ask for.

## Commands

```bash
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm run dev            # node dist/bundle.js (after build)
```

## License

MIT
