# CLAUDE.md — zillow-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.1.0: Zillow MCP server. Default and only transport: localhost WebSocket via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the companion browser extension is installed separately rather than embedded. Every HTTP call to zillow.com is dispatched through the user's signed-in Chrome tab — each request rides their existing session (cookies, TLS, JS context) exactly as if they'd clicked it themselves.

This is a "Pattern A" fetchproxy MCP (every call rides through fetchproxy), not "Pattern B" (one bootstrap call then direct fetch). Zillow validates each request at the session level, so the in-session routing has to be per-call.

## Tool surface

| Tool | File | Endpoint | Kind |
| --- | --- | --- | --- |
| `zillow_search_properties` | `tools/search.ts` | GET `/homes/<location>_rb/?searchQueryState=...` SSR | read |
| `zillow_get_property` | `tools/properties.ts` | GET `/homedetails/<zpid>_zpid/` SSR | read |
| `zillow_get_property_photos` | `tools/photos.ts` | GET `/homedetails/<zpid>_zpid/` SSR (property.photos[]) | read |
| `zillow_get_zestimate_history` | `tools/zestimate.ts` | GET `/homedetails/<zpid>_zpid/` SSR | read |
| `zillow_get_price_history` | `tools/history.ts` | GET `/homedetails/<zpid>_zpid/` SSR (property.priceHistory) | read |
| `zillow_get_tax_history` | `tools/history.ts` | GET `/homedetails/<zpid>_zpid/` SSR (property.taxHistory) | read |
| `zillow_compare_properties` | `tools/compare.ts` | GET `/homedetails/<zpid>_zpid/` SSR ×N (concurrent) | read |
| `zillow_get_saved_searches` | `tools/saved.ts` | GET `/myzillow/SavedSearches` SSR | read (auth) |
| `zillow_get_saved_homes` | `tools/saved.ts` | GET `/myzillow/favorites` SSR (collectionsResponse[].homes) | read (auth) |
| `zillow_get_market_report` | `tools/market.ts` | GET `/home-values/<region>/` SSR | read |
| `zillow_calculate_mortgage` | `tools/mortgage.ts` | (local; no network) | read |
| `zillow_calculate_affordability` | `tools/affordability.ts` | (local; no network) | read |
| `zillow_calculate_rent_vs_buy` | `tools/affordability.ts` | (local; no network) | read |

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

**Exception for first-party dependency bumps.** When bumping a package we own (currently `@fetchproxy/server` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching commit prefix (`feat:` or `fix:`) instead of `chore:`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). On a `pass` verdict it adds the `ready-to-merge` label.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `warn`/`fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

### PR timing — only open when the feature is done

Because PRs auto-merge as soon as auto-review passes, **do not open a PR until the feature is genuinely complete**. There's no draft-PR safety net here:

- Don't open a PR to "stage" work while live verification, follow-up fixes, or final passes are still pending — by the time you finish those, the half-baked PR may already be in `main`.
- Push commits to the branch first; only run `gh pr create` once tests pass, live verification (if applicable) is green, and you'd be comfortable with the change shipping as-is.
- If follow-ups land after a PR is already open, they need to land on the same branch *before* auto-review flips to `pass`. Once the PR squash-merges, late commits orphan onto a stale branch and become their own follow-up PR.
- If you genuinely need a checkpoint review without shipping, open the PR as a GitHub draft (`gh pr create --draft …`) — auto-review skips drafts. Mark it ready-for-review only when the feature is truly done.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## What to not do

- Don't add IP-rotation or TLS-impersonation libraries. The whole design is "every request rides the user's own browser session via fetchproxy." Adding cycletls / curl-impersonate / Playwright would replace that with a separate stand-in identity — which both defeats the design and adds engineering surface.
- Don't paste cookies or env-configure auth. Auth lives in the browser.
- Don't register tools that can't be tested against a mock `ZillowClient`. All tool logic should be behind `fetchJson` / `fetchHtml` so tests can drive it without a real WS.
- Don't bump versions speculatively. release-please owns that.
