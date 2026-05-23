# CLAUDE.md — zillow-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.1.0: Zillow MCP server. Default and only transport: localhost WebSocket via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the companion browser extension is installed separately rather than embedded. Every HTTP call to zillow.com is dispatched through the user's signed-in Chrome tab, so Akamai sees a real browser fetch, not us directly.

This is a "Pattern A" fetchproxy MCP (every call through fetchproxy), not "Pattern B" (one bootstrap call then direct fetch). Zillow's bot wall checks each request, so we can't shortcut.

## Tool surface

| Tool | File | Endpoint | Kind |
| --- | --- | --- | --- |
| `zillow_search_properties` | `tools/search.ts` | POST `/async-create-search-page-state/` | read |
| `zillow_get_property` | `tools/properties.ts` | GET `/homedetails/<zpid>_zpid/` SSR | read |
| `zillow_get_zestimate_history` | `tools/zestimate.ts` | GET `/homedetails/<zpid>_zpid/` SSR | read |
| `zillow_get_saved_searches` | `tools/saved.ts` | GET `/user/savedSearches/` SSR | read (auth) |
| `zillow_get_saved_homes` | `tools/saved.ts` | GET `/myzillow/favorites/` SSR | read (auth) |
| `zillow_get_market_report` | `tools/market.ts` | GET `/home-values/<region>/` SSR | read |
| `zillow_calculate_mortgage` | `tools/mortgage.ts` | (local; no network) | read |

All SSR tools parse `<script id="__NEXT_DATA__">` from the response. Zillow is a Next.js app; `__NEXT_DATA__.props.pageProps` is the canonical hydration root.

## Architecture

```
src/
  index.ts              # entry — builds FetchproxyTransport, ZillowClient,
                        #   registers tool groups, connects stdio transport
  transport.ts          # ZillowTransport interface
  transport-fetchproxy.ts # adapter over @fetchproxy/server's FetchproxyServer
  client.ts             # ZillowClient.fetchHtml / fetchJson + error mapping
                        #   (non-2xx, sign-in interstitial, 204 → null)
  next-data.ts          # extractNextData + getPageProps helpers
  page-props.ts         # findArrayByShape — direct-key + heuristic walker
                        #   used by tools/saved.ts (the page-shape drifts)
  url.ts                # urlToPath — reduce a Zillow URL or bare path
                        #   to its path+search portion
  mcp.ts                # textResult() result-wrapper
  tools/
    search.ts           # zillow_search_properties (buildSearchBody + formatListing)
    properties.ts       # zillow_get_property (findPropertyInPageProps)
    zestimate.ts        # zillow_get_zestimate_history (extractZestimateHistory)
    saved.ts            # zillow_get_saved_searches, zillow_get_saved_homes
    market.ts           # zillow_get_market_report
    mortgage.ts         # zillow_calculate_mortgage (local PITI)

tests/                  # 1:1 mirror of src/, plus tests/helpers.ts harness.
                        #   All tests mock ZillowClient.{fetchHtml,fetchJson}.
```

Each `tools/*.ts` file exports `registerXxxTools(server, client)` (or `(server)` for the local-only mortgage tool); `src/index.ts` calls all of them.

## Commands

```bash
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage  # v8 coverage, no thresholds
npx tsc --noEmit       # typecheck only
node dist/bundle.js    # launch the MCP server over stdio (also opens WS)
```

## Environment

No env vars required. Auth lives in the user's signed-in zillow.com tab via the fetchproxy extension.

Optional:

```
ZILLOW_WS_PORT=37149   # override the fetchproxy WebSocket port
```

## Conventions

- All tools prefixed `zillow_*`.
- Tool return shape: `textResult(data)` from `src/mcp.ts` → `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`. Don't hand-roll the wrapper.
- Tool annotations: every tool sets `title`, `readOnlyHint: true`, `idempotentHint: true`, and `openWorldHint`. The last is `true` for network-bound tools and `false` for `zillow_calculate_mortgage` (pure local computation). v0.1 has no write tools — when added, set `readOnlyHint: false` and consider `destructiveHint`.
- Path-only inputs to `ZillowClient`: pass `/some/path?with=query`, never a full URL. `FetchproxyTransport` prepends `https://www.zillow.com`. When a tool takes a `url` arg from the user, reduce it via `urlToPath` from `src/url.ts`.
- Write a failing test before implementation (TDD).
- ESM + NodeNext: imports use `.js` extensions even for `.ts` source.
- stdio transport: log warnings/banners to **stderr** only — stdout is reserved for JSON-RPC.

## Zillow quirks

- **Next.js hydration.** Zillow embeds full page state as JSON in `<script id="__NEXT_DATA__">`. `src/next-data.ts` extracts it; tools then drill into `props.pageProps` for the per-page data.
- **gdpClientCache is JSON-encoded inside JSON.** The homedetails page has `pageProps.gdpClientCache: "{...}"` (string). `src/tools/properties.ts::findPropertyInPageProps` parses it and finds the first entry with a `property` field.
- **Saved-data field names drift.** `pageProps.savedSearches` was renamed to `userSavedSearches` in at least one redeploy. `src/tools/saved.ts::findSavedSearches` checks the canonical name first, then walks all array fields for a shape-match (`searchQueryState` or `filterState` in the first element).
- **Sign-in detection.** `src/client.ts::throwIfSignInPage` flags `/user/login` redirects, `?login=true` URL params, and the DataDome captcha interstitial (body matches `captcha-delivery` AND body < 80KB — the guard avoids matching the same string in large SSR pages that mention it in passing). We deliberately do NOT body-match `/user/login` since every signed-in Zillow page has a "Sign in" link in its nav that would false-positive.

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Version appears in EIGHT places — all must match:

1. `package.json` → `"version"`
2. `package-lock.json` → kept in sync by `npm install --package-lock-only`
3. `src/index.ts` → `VERSION` const (annotated with `// x-release-please-version`) + startup banner
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version`
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → `metadata.version` + `plugins[].version`

`release-please-config.json` registers all of these as `extra-files` so the release-please workflow rewrites them in one PR per release.

release-please-config.json registers all of these as `extra-files` so the release-please workflow rewrites them in one PR per release.

### Release flow

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`) opens or updates a release PR whenever Conventional-Commit messages (`feat:`, `fix:`, etc.) accumulate. Merging the release PR creates the tag and a GitHub Release; the `publish` job then packs `.mcpb` + `.skill`, publishes to npm with provenance, and pushes to the MCP Registry.

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. release-please owns versioning.

## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* the auto-generated release notes block (configured in `.github/release.yml`).

For every PR, apply exactly one label:

| Label                  | Section in release notes |
|------------------------|--------------------------|
| `enhancement`          | Features                 |
| `bug`                  | Bug Fixes                |
| `security`             | Security                 |
| `refactor`             | Refactor                 |
| `documentation`        | Documentation            |
| `test`                 | Tests                    |
| `dependencies`         | Dependencies             |
| `ci` / `github_actions`| CI & Build               |
| *(none / unmatched)*   | Other Changes            |
| `ignore-for-release`   | Hidden from notes        |

Open with `gh pr create --label <label>`, then `gh pr merge <num> --auto --merge`. Repo allows merge commits only — never `--squash`/`--rebase`.

## What to not do

- Don't add IP-rotation / TLS-impersonation tricks. v0.1's whole design is "the fetchproxy bridge is the bot-bypass strategy." Adding cycletls / curl-impersonate / Playwright is duplicate engineering and won't beat Akamai anyway.
- Don't paste cookies or env-configure auth. Auth lives in the browser.
- Don't register tools that can't be tested against a mock `ZillowClient`. All tool logic should be behind `fetchJson` / `fetchHtml` so tests can drive it without a real WS.
- Don't bump versions speculatively. release-please owns that.
