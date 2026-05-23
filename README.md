# zillow-mcp

Zillow real-estate access as an MCP server for Claude — search listings, fetch property details, Zestimate history, your saved searches & homes, and market reports via natural language.

> ⚠️ Zillow does not publish a public consumer API. The official [Bridge API](https://www.bridgeinteractive.com/developers/bridge-api/) is gated to MLS partners. This server uses the same private endpoints the zillow.com web app uses, routed through your own signed-in browser tab via the [fetchproxy](https://github.com/chrischall/fetchproxy) extension. Akamai / PerimeterX see a real browser session, not a Node process — but you should still treat this as informal use of Zillow's website. Use at your own discretion.

## Why this exists

The four existing Zillow MCPs all sit on one of two foundations:

- The **Bridge API** — requires MLS membership, IDX vendor relationship, or "approved technology partnership" (10+ business-day approval). Consumers can't get in.
- A **paid scraper** (RapidAPI, Apify) — adds a third party to the trust path and rate-limits.

None of them can see what *you* have saved, favorited, or recently viewed — because both Bridge and third-party scrapers are out-of-session. zillow-mcp uses your already-signed-in zillow.com tab.

## Tools

| Tool | Purpose | Auth-scoped |
| --- | --- | :---: |
| `zillow_search_properties` | Search listings by location and filters | |
| `zillow_get_property` | Full record for a zpid (price, Zestimate, beds, schools, history) | |
| `zillow_get_zestimate_history` | Time series of Zestimate values | |
| `zillow_get_saved_searches` | Your saved searches with new-listing counts | ✓ |
| `zillow_get_saved_homes` | Your favorited homes | ✓ |
| `zillow_get_market_report` | Median price, days on market, ZHVI for a region | |
| `zillow_calculate_mortgage` | Local PITI calculator (no network) | |

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

The MCP server runs in Node, but every HTTP call to zillow.com is dispatched into your live browser tab through the fetchproxy extension. Akamai sees a real browser making a real request from a real session — `_abck`, TLS fingerprint, cookies all match the page that's already on screen. No headless browser, no impersonation, no proxy farm.

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
