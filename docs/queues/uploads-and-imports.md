# Uploads and imports - open queue

Uploads, URL and yt-dlp downloads, one-click site imports, the browser
extension's import flows, and importing from booru search. Rows: one line and a
pointer (`- [ ] **what** · area · evidence · status`); claim with
`**TAKEN <date> <who>**` before starting; the landing commit deletes the row.
Where a row and its evidence disagree, the evidence wins.

## Open

- [ ] **The booru import rules exist twice - once in the extension, once in the web app - and must be kept identical by hand: the post-create body, the duplicate merge body, tag display names, download progress text, pacing/backoff. Give them one owner (a shared module both build from, or a backend import endpoint both call) so a fix lands once.** · import flow · evidence: `siteImportPostBody`, `downloadProgressText` in `browser-extension/site-import-core.js`; `mergeDuplicate`, `importAll` in `browser-extension/site-import.js`; `importPostBody`, `mergePostBody`, `downloadProgressText` in `frontend/src/remote/useImportQueue.js` · UNCLAIMED
- [ ] **The extension's upload-page booru tag reader does not decode HTML entities from Gelbooru/Moebooru JSON, so escaped tags (`girls&#039;_frontline`) still flatten to junk there; decode before `addBooruTag`.** · extension upload · evidence: `parseGelbooruJson`, `parseMoebooruJson` in `browser-extension/booru-tags.js`; decoder added in `site-import-core.js` `0741586` · **TAKEN 2026-10-13 L3-ext**
- [ ] **The Gelbooru-family HTML-entity decoder exists three times (extension core, frontend Gelbooru and Safebooru adapters); give it one owner per bundle.** · import flow · evidence: `decodeEntities` in `browser-extension/site-import-core.js`, `frontend/src/remote/adapters/safebooru.js`, `frontend/src/remote/adapters/gelbooru.js` · **TAKEN 2026-10-13 L1-front+L3-ext**
- [ ] **The extension's Safebooru import sends `tagDisplayNames: {}`, so decoded tags like `girls'_frontline` lose their real spelling when NekoBooru flattens them; use `booruDisplayNames(tags)` as the Danbooru and Gelbooru-search paths do.** · extension import · evidence: `safebooruImportJob`, `sanitizeSafebooruImportJob` in `browser-extension/site-import-core.js` · **TAKEN 2026-10-13 L3-ext**
- [ ] **The `timeoutSignal` helper (abort on a parent signal or after N ms) is copied in the Danbooru and e621 adapters; give it one owner in `frontend/src/remote/`.** · booru search · evidence: `timeoutSignal` in `frontend/src/remote/adapters/danbooru.js` and `frontend/src/remote/adapters/e621.js` · **TAKEN 2026-10-13 L1-front**
- [ ] **The Danbooru tag-category lookup for Safebooru exists twice (web resolver and extension script) with the same batching, cache and timeout rules; give it one owner, or a shared fixture test that keeps both in step.** · import flow · evidence: `createDanbooruCategoryResolver` in `frontend/src/remote/danbooruCategories.js`, `resolveDanbooruCategories` in `browser-extension/danbooru-categories.js` (`eaf1e3f`) · **TAKEN 2026-10-13 L3-ext**
