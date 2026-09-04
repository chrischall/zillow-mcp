---
name: zillow
description: Look up real-estate listings, property details, Zestimates, saved searches/homes, and market reports on Zillow via MCP. Triggers on phrases like "find homes in", "what's the Zestimate for", "show my saved Zillow homes", "what's my saved Zillow search seeing", "what does Zillow say about", "Zillow market report for", or any request involving Zillow properties, prices, or your saved Zillow activity. Requires zillow-mcp installed and the fetchproxy extension active (see Setup below).
---

# zillow-mcp

MCP server for Zillow — natural-language access to listings, property records, Zestimates, your saved searches/homes, and market reports. Routes through your signed-in zillow.com tab via the fetchproxy browser extension, so Akamai sees a real browser session instead of a Node process.

- **npm:** [npmjs.com/package/zillow-mcp](https://www.npmjs.com/package/zillow-mcp)
- **Source:** [github.com/chrischall/zillow-mcp](https://github.com/chrischall/zillow-mcp)

> ⚠️ Zillow does not publish a public consumer API. This server uses the same private endpoints the zillow.com web app calls, dispatched through your own signed-in browser tab via the fetchproxy extension. Use at your own discretion.

## Setup

### 1. Install zillow-mcp

`.mcp.json` (project) or `~/.claude/mcp.json` (global):

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

### 2. Install the fetchproxy extension (one-time, shared across all fetchproxy-based MCPs)

```bash
git clone https://github.com/chrischall/fetchproxy
cd fetchproxy
npm ci
npm --workspace=@fetchproxy/extension-chrome run build
```

Then in Chrome: `chrome://extensions` → Developer mode → Load unpacked → pick `packages/extension-chrome/dist/`.

### 3. Open zillow.com and sign in.

That's it. No API keys, no env vars.

## Tools

### Public data

- **`zillow_search_properties`** — Search by location + filters (price, beds, home type, status). Returns matching listings with price, Zestimate, beds/baths, sqft, image, and homedetails URL.
- **`zillow_get_property`** — Full property record by `zpid` or homedetails URL. Returns address, price, Zestimate, rent Zestimate, beds, baths, sqft, year built, schools, price history.
- **`zillow_get_zestimate_history`** — Time series of Zestimate values for a property.
- **`zillow_get_market_report`** — Median sale/list/rent price, days on market, inventory, ZHVI for a Zillow region (e.g. `/home-values/6181/brooklyn-ny/`).
- **`zillow_calculate_mortgage`** — Local PITI calculator. No network call. Provide home price, interest rate, optional down payment / taxes / insurance / HOA / PMI; returns a full monthly breakdown.

### Signed-in user data (the unique value vs. Bridge-API competitors)

- **`zillow_get_saved_searches`** — Your saved searches, with new-listing counts and notification frequency.
- **`zillow_get_saved_homes`** — Homes you've favorited.

## Response shape (`view`)

Three of this server's twenty tools take `view: "compact" | "full"` —
**`zillow_search_properties`**, **`zillow_get_by_address`** and
**`zillow_resolve_addresses`** — and on all three **`compact` is the DEFAULT**.
The slim rung is what you get without asking for it.

**Compact here is media stripping, not a field projection.** `src/view.ts`
writes no field list, because this repo holds no captured Zillow payload from
which one could honestly be derived. It removes keys whose value is a picture
plus bare image URLs, which is subtractive and so cannot drop a field nobody
knew about.

### `image_url` is KEPT — the opposite of what "compact strips media" implies

Read that again before you plan around it. A listing's `image_url` survives
compact, on purpose, via an explicit `keep` rule.

It is not incidental decoration: `search.ts` DERIVES it, off `photos` or
`responsivePhotos` depending on which page shape Zillow served, so that a
single-address hit carries an image like a real search hit does. That is a
field choice made *with* knowledge of the API, and the blind subtractive rule
must not overrule it. If you want the whole gallery,
`zillow_get_property_photos` is the tool.

The consequence is worth stating plainly, because it will otherwise look like
the parameter is broken: **`image_url` is the ONLY media field a formatted
listing carries**, so today compact and full serialise to the SAME BYTES on
all three tools. `formatListing` sets `image_url` from `imgSrc` on a real
search hit and from `firstPhotoUrl` on an adapted homedetails hit, and every
other key on the record is an address, a number, or the homedetails `url` —
which is a page, not a picture, and which the rule already leaves alone.

So `view` on these three is a wiring contract, not a saving you can measure
yet: it starts mattering the moment a media field is added to the listing
shape. (A repo test pins the wiring for exactly this reason — because the
output cannot tell an honoured `view` from an ignored one, a regression here
would look like nothing at all.)

`view: "full"` returns the formatted record untouched. There is deliberately
**no `raw` rung**: nothing here re-serialises Zillow's payload after
formatting, so `full` already IS what the tool built, and a third value would
silently alias one that exists.

### Why the other seventeen have none

- **`zillow_get_property_photos`** — its PRODUCT is the image. Stripping media
  there would not shrink the response, it would empty it. This tool is the
  canonical example in the shared helper's own documentation of where the rule
  must never be applied.
- **`zillow_get_property`** already IS a hand-written field projection: the
  raw `description`, `price_history` and `tax_history` are opt-in
  (`include_*`), and `extracted_features` is derived. A second projection on
  top would fight the first.
- **`zillow_bulk_get` and `zillow_compare_properties`** are built out of that
  same formatted record, so they inherit its projection rather than needing
  their own.
- **`zillow_get_price_history`, `zillow_get_tax_history`,
  `zillow_get_zestimate_history`, `zillow_get_market_report`** answer with
  hand-shaped series and metrics — dates and numbers. There is no picture in a
  time series.
- **`zillow_calculate_mortgage`, `zillow_calculate_affordability`,
  `zillow_estimate_rent_vs_buy`** make no network call at all. They compute
  from your inputs, so there is no upstream payload to project.
- **`zillow_get_saved_homes` and `zillow_get_saved_searches`** answer with
  hand-shaped records of your own saved activity. Note that a saved home
  carries a constructed `image_url` too, from `imgSrc` — consistent with the
  three tools above, and returned unconditionally here.
- **`zillow_register_session`, `zillow_set_active_session`,
  `zillow_get_session_context`** answer with a receipt or with session state.
- **`zillow_healthcheck`** answers with a bridge diagnostic.

Passing `view` to one of those is not an error and will not fail: the tool
does not declare it, so zod drops the unknown key and the call runs exactly as
it would have. Nothing warns you, so a successful call is not evidence the
rung was honoured.

## Trigger examples

- "Find me 2-bedroom condos under $1.5M in Brooklyn" → `zillow_search_properties`
- "What's the Zestimate on 123 Main St?" → resolve to zpid, then `zillow_get_property`
- "How has the Zestimate for zpid 12345 changed?" → `zillow_get_zestimate_history`
- "What's new on my saved Zillow searches?" → `zillow_get_saved_searches`
- "Pull up my saved homes on Zillow" → `zillow_get_saved_homes`
- "Brooklyn real-estate market trends" → `zillow_get_market_report`
- "Monthly payment on a $500k home, 20% down, 6.5% rate" → `zillow_calculate_mortgage`

## Gotchas

- **Sign-in required for saved-* tools.** If the user isn't signed into zillow.com in the bridged Chrome tab, those tools fail with `SessionNotAuthenticatedError`. Public tools work either way, but signed-in sessions are more reliable against captcha walls.
- **Captcha interstitial.** Zillow occasionally serves a captcha to fresh sessions. Solving it in the Chrome tab once unblocks subsequent fetches.
- **No write surface yet.** All tools are read-only. Saving a home / search / contact form are not implemented in v0.1.
