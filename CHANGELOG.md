# Changelog

## [0.5.0](https://github.com/chrischall/zillow-mcp/compare/v0.4.5...v0.5.0) (2026-05-26)


### Features

* **get_by_address:** add zillow_get_by_address for one-shot address → zpid ([#37](https://github.com/chrischall/zillow-mcp/issues/37)) ([a9308d1](https://github.com/chrischall/zillow-mcp/commit/a9308d161d0d6ef338746c638415c0eaf61915ed))
* **healthcheck:** add zillow_healthcheck for bridge diagnostics ([#36](https://github.com/chrischall/zillow-mcp/issues/36)) ([203fa51](https://github.com/chrischall/zillow-mcp/commit/203fa51cc74656c952145dac6f11187d9ce48647))


### Bug Fixes

* **get_property:** fall back to resoFacts.yearBuilt when top-level is null ([#34](https://github.com/chrischall/zillow-mcp/issues/34)) ([2a8cc42](https://github.com/chrischall/zillow-mcp/commit/2a8cc42aae47c293aeece035b0d59ea5dc9a525c))
* **get_property:** surface mlsStreetAddress alongside streetAddress ([#35](https://github.com/chrischall/zillow-mcp/issues/35)) ([678c440](https://github.com/chrischall/zillow-mcp/commit/678c440695bf2d68f7b227e1b53f42fe824ee787))
* **search:** handle address & street-level queries without a regionSelection ([#38](https://github.com/chrischall/zillow-mcp/issues/38)) ([c938821](https://github.com/chrischall/zillow-mcp/commit/c93882155ad5dc33bd6f39710dbee960d7a4b0b4))

## [0.4.5](https://github.com/chrischall/zillow-mcp/compare/v0.4.4...v0.4.5) (2026-05-26)


### Documentation

* **claude:** warn against early PRs and call out first-party dep bumps ([#27](https://github.com/chrischall/zillow-mcp/issues/27)) ([ca71ab5](https://github.com/chrischall/zillow-mcp/commit/ca71ab56e53818b1d7ba0cdaae6d0ca33a807a6e))

## [0.4.4](https://github.com/chrischall/zillow-mcp/compare/v0.4.3...v0.4.4) (2026-05-25)


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#24](https://github.com/chrischall/zillow-mcp/issues/24)) ([f226f9b](https://github.com/chrischall/zillow-mcp/commit/f226f9b03d60b661c2d31f6f59cfd824f24cea80))

## [0.4.3](https://github.com/chrischall/zillow-mcp/compare/v0.4.2...v0.4.3) (2026-05-25)


### Bug Fixes

* **search+get_property:** resolve location explicitly, reject slug-only URLs ([#21](https://github.com/chrischall/zillow-mcp/issues/21)) ([9367861](https://github.com/chrischall/zillow-mcp/commit/93678612bf279942de3ec8ffe5300a66ed7d5c46))

## [0.4.2](https://github.com/chrischall/zillow-mcp/compare/v0.4.1...v0.4.2) (2026-05-24)


### Documentation

* canonical auto-merge guidance + softer fetchproxy framing ([#19](https://github.com/chrischall/zillow-mcp/issues/19)) ([e2a0143](https://github.com/chrischall/zillow-mcp/commit/e2a01438fb14c65e541eba25c0c31afcc9c83672))

## [0.4.1](https://github.com/chrischall/zillow-mcp/compare/v0.4.0...v0.4.1) (2026-05-24)


### Bug Fixes

* **photos:** omit per-photo source lists by default ([#17](https://github.com/chrischall/zillow-mcp/issues/17)) ([5bc79dc](https://github.com/chrischall/zillow-mcp/commit/5bc79dcfb5e06e987e672eebe693b1be4496b63a))

## [0.4.0](https://github.com/chrischall/zillow-mcp/compare/v0.3.0...v0.4.0) (2026-05-24)


### Features

* add zillow_get_property_photos tool ([#15](https://github.com/chrischall/zillow-mcp/issues/15)) ([f0c57b0](https://github.com/chrischall/zillow-mcp/commit/f0c57b0c25918504318de42d09eeb77a25adb92b))

## [0.3.0](https://github.com/chrischall/zillow-mcp/compare/v0.2.2...v0.3.0) (2026-05-24)


### Features

* v0.3 — 5 new tools (compare, price/tax history, affordability, rent-vs-buy) ([#13](https://github.com/chrischall/zillow-mcp/issues/13)) ([e170470](https://github.com/chrischall/zillow-mcp/commit/e1704708afe787c20fb93607da85df0cfd77d7fd))


### Documentation

* add Acknowledgement of Terms section to README ([#11](https://github.com/chrischall/zillow-mcp/issues/11)) ([7b8e7e5](https://github.com/chrischall/zillow-mcp/commit/7b8e7e5aeb6f594038523e641b3e20bbf2516f71))

## [0.2.2](https://github.com/chrischall/zillow-mcp/compare/v0.2.1...v0.2.2) (2026-05-23)


### Bug Fixes

* **tools:** correct live Zillow endpoints + parse paths (v0.2.1 was DOA) ([#9](https://github.com/chrischall/zillow-mcp/issues/9)) ([f9cde33](https://github.com/chrischall/zillow-mcp/commit/f9cde33bbe17d1e8c63249317e178c245b7a8a20))

## [0.2.1](https://github.com/chrischall/zillow-mcp/compare/v0.2.0...v0.2.1) (2026-05-23)


### Bug Fixes

* **server.json:** shorten description to ≤100 chars for MCP Registry ([f544a6a](https://github.com/chrischall/zillow-mcp/commit/f544a6a31f8ef0c87b0782235f15653a8c112a42))


### Documentation

* **claude-md:** call out 100-char limit on server.json description ([e9da073](https://github.com/chrischall/zillow-mcp/commit/e9da073ddb0a554a69afa2ada3d6e086b2f914ab))
* **claude-md:** call out 100-char limit on server.json description ([697cbc4](https://github.com/chrischall/zillow-mcp/commit/697cbc4ac38c2a7ee0551733bd9ab516cd30de98))

## [0.2.0](https://github.com/chrischall/zillow-mcp/compare/v0.1.0...v0.2.0) (2026-05-23)


### Features

* initial zillow-mcp scaffold ([59a2a20](https://github.com/chrischall/zillow-mcp/commit/59a2a2034a0e04c4344f73922009e770884716ba))


### Refactor

* code review polish — full tool annotations, shared utils, tighter coverage ([1dee256](https://github.com/chrischall/zillow-mcp/commit/1dee2566535d97e321befc579621d3792f588684))
