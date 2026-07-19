# Changelog

## [0.11.1](https://github.com/chrischall/zillow-mcp/compare/v0.11.0...v0.11.1) (2026-07-19)


### Documentation

* replace duplicated fleet policy with a pointer ([#177](https://github.com/chrischall/zillow-mcp/issues/177)) ([1e53fc5](https://github.com/chrischall/zillow-mcp/commit/1e53fc55b7b553cdb0fcddf51a8aabdab43118a5))

## [0.11.0](https://github.com/chrischall/zillow-mcp/compare/v0.10.6...v0.11.0) (2026-07-13)


### Features

* **skill:** add zillow fpx access skill ([#171](https://github.com/chrischall/zillow-mcp/issues/171)) ([627282a](https://github.com/chrischall/zillow-mcp/commit/627282a5dc4729d611f1b9cb6fcd102f80b33f73)), closes [#172](https://github.com/chrischall/zillow-mcp/issues/172)


### Refactor

* **skill:** move root SKILL.md into skills/, point plugin.json at ./skills/ ([#173](https://github.com/chrischall/zillow-mcp/issues/173)) ([f8bbcd0](https://github.com/chrischall/zillow-mcp/commit/f8bbcd07e5f2a67bff1572de17a6e7cee324f156))

## [0.10.6](https://github.com/chrischall/zillow-mcp/compare/v0.10.5...v0.10.6) (2026-07-07)


### Bug Fixes

* bump @chrischall/mcp-utils to 0.12.0 ([#167](https://github.com/chrischall/zillow-mcp/issues/167)) ([a5d098a](https://github.com/chrischall/zillow-mcp/commit/a5d098a5af7cff1f865b181673d8329374bf718d))


### Refactor

* adopt registerBridgeHealthcheckTool + shared BotWall/SessionNotAuth errors ([#165](https://github.com/chrischall/zillow-mcp/issues/165)) ([37b0abc](https://github.com/chrischall/zillow-mcp/commit/37b0abc31c8a4c2c0c3026c89a28051ae6da9075))

## [0.10.5](https://github.com/chrischall/zillow-mcp/compare/v0.10.4...v0.10.5) (2026-06-15)


### Documentation

* audit CLAUDE.md + add auto-review follow-up convention ([#156](https://github.com/chrischall/zillow-mcp/issues/156)) ([2278278](https://github.com/chrischall/zillow-mcp/commit/2278278a1ccd7e0dd3a34216ec7257c4bb2c0646))
* require Conventional Commit PR titles for release-please ([#152](https://github.com/chrischall/zillow-mcp/issues/152)) ([2863e97](https://github.com/chrischall/zillow-mcp/commit/2863e97e25f502290f4602edecb46464ac6abc63))

## [0.10.4](https://github.com/chrischall/zillow-mcp/compare/v0.10.3...v0.10.4) (2026-06-13)


### Bug Fixes

* bot PRs bypass the CI gate unconditionally (upstream curtaincall[#86](https://github.com/chrischall/zillow-mcp/issues/86) review) ([#146](https://github.com/chrischall/zillow-mcp/issues/146)) ([7b98fa8](https://github.com/chrischall/zillow-mcp/commit/7b98fa8244297f3a3e49494ae7356bab98c8a153))


### Documentation

* add MIT LICENSE file and README badges ([#143](https://github.com/chrischall/zillow-mcp/issues/143)) ([13c41a7](https://github.com/chrischall/zillow-mcp/commit/13c41a7e2af906a61a34a3cde8492b31c3dfdb23))

## [0.10.3](https://github.com/chrischall/zillow-mcp/compare/v0.10.2...v0.10.3) (2026-06-10)


### Bug Fixes

* bound zillow_resolve_addresses with an overall deadline + pending backfill ([#140](https://github.com/chrischall/zillow-mcp/issues/140)) ([319f08d](https://github.com/chrischall/zillow-mcp/commit/319f08d30962c30279b7b3ad36651b21dcbec124))


### Refactor

* adopt shared chunk/sleep from @chrischall/mcp-utils 0.7.0 ([#138](https://github.com/chrischall/zillow-mcp/issues/138)) ([f4d6704](https://github.com/chrischall/zillow-mcp/commit/f4d6704f4d660f587f5a7b96d18d380e02eca1bc))

## [0.10.2](https://github.com/chrischall/zillow-mcp/compare/v0.10.1...v0.10.2) (2026-06-07)


### Documentation

* neutral wording for fetchproxy routing in description ([#136](https://github.com/chrischall/zillow-mcp/issues/136)) ([6d2eeee](https://github.com/chrischall/zillow-mcp/commit/6d2eeee3214def63f88fc7769205470057feb427))

## [0.10.1](https://github.com/chrischall/zillow-mcp/compare/v0.10.0...v0.10.1) (2026-06-04)


### Bug Fixes

* adopt @fetchproxy/server 0.13.0 (bridge host failover + re-pairing) ([#130](https://github.com/chrischall/zillow-mcp/issues/130)) ([4ac24e2](https://github.com/chrischall/zillow-mcp/commit/4ac24e2bcced0bd8078518281a55b49aa25b4158))
* adopt @fetchproxy/server 1.0.0 + @chrischall/mcp-utils 0.5.0 ([#132](https://github.com/chrischall/zillow-mcp/issues/132)) ([ac00850](https://github.com/chrischall/zillow-mcp/commit/ac00850ecc9b047d9a2fdab9e1b7bcb1e5c4be0b))

## [0.10.0](https://github.com/chrischall/zillow-mcp/compare/v0.9.1...v0.10.0) (2026-05-30)


### Features

* **history:** explain empty zestimate/price/tax series with a note (Bug [#1](https://github.com/chrischall/zillow-mcp/issues/1)) ([#120](https://github.com/chrischall/zillow-mcp/issues/120)) ([73349b9](https://github.com/chrischall/zillow-mcp/commit/73349b9ae0fa313b3f80c2cc17f491f10e638991))


### Bug Fixes

* **properties:** retire the dead GraphQL property fetch, go SSR-only ([#116](https://github.com/chrischall/zillow-mcp/issues/116)) ([4e1e9c0](https://github.com/chrischall/zillow-mcp/commit/4e1e9c0d728690e22580f2b137d53b592e94b147))
* **search:** return the single listing when an address resolves to a homedetails page ([#119](https://github.com/chrischall/zillow-mcp/issues/119)) ([be64826](https://github.com/chrischall/zillow-mcp/commit/be6482652130cfc70476e1b09115f42096828916))


### Refactor

* **search:** map image_url + parse pageProps once (addresses [#119](https://github.com/chrischall/zillow-mcp/issues/119) nits) ([#122](https://github.com/chrischall/zillow-mcp/issues/122)) ([d274199](https://github.com/chrischall/zillow-mcp/commit/d2741991e50d587bf6bf4acfce1c2d6d9742f107))


### Documentation

* **properties:** document zest_vs_list_pct sign convention in the tool description ([#121](https://github.com/chrischall/zillow-mcp/issues/121)) ([55df20d](https://github.com/chrischall/zillow-mcp/commit/55df20dff5acfb05c910356512e4cd5ba2b7a14b))
* **test:** refresh px-sensor regression-test comment after [#115](https://github.com/chrischall/zillow-mcp/issues/115) ([#117](https://github.com/chrischall/zillow-mcp/issues/117)) ([c778cb8](https://github.com/chrischall/zillow-mcp/commit/c778cb825a78dfbcee4a70115d318b9dad417adc))

## [0.9.1](https://github.com/chrischall/zillow-mcp/compare/v0.9.0...v0.9.1) (2026-05-30)


### Bug Fixes

* **client:** guard px bot-wall check with the __NEXT_DATA__ SSR marker ([#112](https://github.com/chrischall/zillow-mcp/issues/112)) ([9ffc7c7](https://github.com/chrischall/zillow-mcp/commit/9ffc7c7db5a1f4be32ef45303ea3ff3d0a25bcba))
* **deps:** adopt @fetchproxy/server 0.11.1 — fixed classifyBotWall ([#114](https://github.com/chrischall/zillow-mcp/issues/114)) ([76a9527](https://github.com/chrischall/zillow-mcp/commit/76a9527c1295eb89b9ecd88260e278638bf003ed))


### Refactor

* **client:** drop the local __NEXT_DATA__ bot-wall guard ([#115](https://github.com/chrischall/zillow-mcp/issues/115)) ([eeb1c66](https://github.com/chrischall/zillow-mcp/commit/eeb1c66157a60312ea0a1e17e25d48fb495acbc1))

## [0.9.0](https://github.com/chrischall/zillow-mcp/compare/v0.8.0...v0.9.0) (2026-05-29)


### Features

* canonical GetAutocompleteResults typeahead rung in address resolver ([#105](https://github.com/chrischall/zillow-mcp/issues/105)) ([b780fa4](https://github.com/chrischall/zillow-mcp/commit/b780fa4fadfc597a2bfba283fa4763d3167f834c))
* **deps:** adopt @fetchproxy/server 0.11.0 + @chrischall/realty-core 0.4.1 ([#111](https://github.com/chrischall/zillow-mcp/issues/111)) ([d8baa6a](https://github.com/chrischall/zillow-mcp/commit/d8baa6a41976b26ec483eb08245bdf9a3f2a2bfe))
* inline-first GraphQL property fetch — shirk the static persisted-query hash ([#104](https://github.com/chrischall/zillow-mcp/issues/104)) ([9c08b0e](https://github.com/chrischall/zillow-mcp/commit/9c08b0ef68744f0fad96378b58dcf1539ab5db19))


### Bug Fixes

* **ci:** arm auto-merge from verdict comment when structured_output is empty ([#108](https://github.com/chrischall/zillow-mcp/issues/108)) ([49bd246](https://github.com/chrischall/zillow-mcp/commit/49bd2464300cc73c38cad82c85b559fdb1629f0b))
* **ci:** treat instant-merge race as success in auto-merge arm ([#107](https://github.com/chrischall/zillow-mcp/issues/107)) ([dbcbfbe](https://github.com/chrischall/zillow-mcp/commit/dbcbfbe13b39ecc5cceddf115c491997b3f631df))
* **resolver:** anchor resolveDirect match on street number ([#110](https://github.com/chrischall/zillow-mcp/issues/110)) ([01148fe](https://github.com/chrischall/zillow-mcp/commit/01148fe7bb8940fc88fba3e7647eb74a290c9a01))

## [0.8.0](https://github.com/chrischall/zillow-mcp/compare/v0.7.0...v0.8.0) (2026-05-29)


### Features

* adopt @chrischall/realty-core 0.4.0 (marina place-name guard + completed→Sold) ([#97](https://github.com/chrischall/zillow-mcp/issues/97)) ([051712e](https://github.com/chrischall/zillow-mcp/commit/051712e826177d678f5a530fd156ab10e34e0045))
* adopt realty-core extractFeatures (canonical basement detector) + drop inline copy ([#96](https://github.com/chrischall/zillow-mcp/issues/96)) ([ce8846b](https://github.com/chrischall/zillow-mcp/commit/ce8846b467d5e65bd5f712c3d1a571ecc182fe61))
* consume @chrischall/realty-core 0.3.1 — drop inline hoisted helpers ([#95](https://github.com/chrischall/zillow-mcp/issues/95)) ([0be850a](https://github.com/chrischall/zillow-mcp/commit/0be850a0ca5f3d36fe7fb0ee45eebdf90ae6e376))
* **properties:** add derived lot_size_acres ([#82](https://github.com/chrischall/zillow-mcp/issues/82)) ([#93](https://github.com/chrischall/zillow-mcp/issues/93)) ([1ad922c](https://github.com/chrischall/zillow-mcp/commit/1ad922c9f5c02c0e66f0e69f3dd3ea04b514e898))


### Bug Fixes

* **bulk-get:** classify PerimeterX captcha, throttle, and auto-chunk ([#90](https://github.com/chrischall/zillow-mcp/issues/90)) ([#91](https://github.com/chrischall/zillow-mcp/issues/91)) ([4fb6ac3](https://github.com/chrischall/zillow-mcp/commit/4fb6ac3bdc248eebda42586feebe598476630d2e))

## [0.7.0](https://github.com/chrischall/zillow-mcp/compare/v0.6.0...v0.7.0) (2026-05-28)


### Features

* **resolve:** round-3 P0 wave — bulk/single parity + bidirectional tokens + locality remap + price_hint + test corpus ([#82](https://github.com/chrischall/zillow-mcp/issues/82)) ([1113c12](https://github.com/chrischall/zillow-mcp/commit/1113c12e636cf7e7c5e8b2ec7d2cba20f737f16b))
* round-3 P1 wave — zestimate_status + bulk concurrency/retry + compare cap ([#84](https://github.com/chrischall/zillow-mcp/issues/84)) ([896dd11](https://github.com/chrischall/zillow-mcp/commit/896dd11091b5fbc9a10d3c386068a0dfba5b458d))


### Bug Fixes

* address round-3 P0 wave review nits ([#82](https://github.com/chrischall/zillow-mcp/issues/82) follow-up) ([#86](https://github.com/chrischall/zillow-mcp/issues/86)) ([0a966b7](https://github.com/chrischall/zillow-mcp/commit/0a966b75fe2cb96f470f22a1675aa26479f950c8))
* round-3 P1 wave review follow-ups ([#84](https://github.com/chrischall/zillow-mcp/issues/84)) ([#85](https://github.com/chrischall/zillow-mcp/issues/85)) ([cfe30f6](https://github.com/chrischall/zillow-mcp/commit/cfe30f671a7f9df768a823528bf9f7f61ed35a90))


### Documentation

* **tools:** round-3 description-honesty sweep (closes [#80](https://github.com/chrischall/zillow-mcp/issues/80)) ([#88](https://github.com/chrischall/zillow-mcp/issues/88)) ([4b9f694](https://github.com/chrischall/zillow-mcp/commit/4b9f694407938106c727136ef6bc14c9a2b8af59))

## [0.6.0](https://github.com/chrischall/zillow-mcp/compare/v0.5.0...v0.6.0) (2026-05-27)


### Features

* **bulk:** add zillow_bulk_get + zillow_resolve_addresses ([#64](https://github.com/chrischall/zillow-mcp/issues/64)) ([9d69ef5](https://github.com/chrischall/zillow-mcp/commit/9d69ef59e6706bf70f8efa784f6b72a0ae80b707))
* **history:** events_normalized taxonomy + bundle history into get_property ([#68](https://github.com/chrischall/zillow-mcp/issues/68)) ([305c34c](https://github.com/chrischall/zillow-mcp/commit/305c34cf5075f4e74442e704c0a76c31ddbf9e30))
* **p0:** default include_description=false + server-side extracted_features ([#61](https://github.com/chrischall/zillow-mcp/issues/61)) ([12c5cb8](https://github.com/chrischall/zillow-mcp/commit/12c5cb8ee40e77e67b882e802e6f2fa0a12ab5ff))
* **p1-schema:** derived fields, normalized HOA, tax cleanup, summary opt-in ([#63](https://github.com/chrischall/zillow-mcp/issues/63)) ([b816715](https://github.com/chrischall/zillow-mcp/commit/b81671576d24b5cb086263dbe805a36569938737))
* **sessions:** multi-session registry + register/set_active/get_session_context tools ([#65](https://github.com/chrischall/zillow-mcp/issues/65)) ([ddf0dda](https://github.com/chrischall/zillow-mcp/commit/ddf0ddad494b7d0626bbbaff902d7bbab9748704))
* **transport-fetchproxy,healthcheck:** adopt @fetchproxy/server 0.8.0 + surface bridge hints ([#72](https://github.com/chrischall/zillow-mcp/issues/72)) ([3c192da](https://github.com/chrischall/zillow-mcp/commit/3c192da14998a0d7114a647725d87a6a09df4b90))


### Bug Fixes

* **get_by_address:** retry with suffix expansion + search fallback ([#66](https://github.com/chrischall/zillow-mcp/issues/66)) ([294c923](https://github.com/chrischall/zillow-mcp/commit/294c92383331584acefe77c3b8eeb4fc389c68d2))
* **p0:** address PR [#61](https://github.com/chrischall/zillow-mcp/issues/61) polish nits ([#70](https://github.com/chrischall/zillow-mcp/issues/70)) ([a176a1d](https://github.com/chrischall/zillow-mcp/commit/a176a1da2fa55829e4315802ae3f1911d9e85353))
* **search:** auto-paginate when limit &gt; one Zillow page (~40) ([#67](https://github.com/chrischall/zillow-mcp/issues/67)) ([24065ac](https://github.com/chrischall/zillow-mcp/commit/24065acf484534ce0b3a1b224d441e1abb3384ab))

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
