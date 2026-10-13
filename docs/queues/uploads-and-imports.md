# Uploads and imports - open queue

Uploads, URL and yt-dlp downloads, one-click site imports, the browser
extension's import flows, and importing from booru search. Rows: one line and a
pointer (`- [ ] **what** · area · evidence · status`); claim with
`**TAKEN <date> <who>**` before starting; the landing commit deletes the row.
Where a row and its evidence disagree, the evidence wins.

## Open

- [ ] **The booru import rules exist twice - once in the extension, once in the web app - and must be kept identical by hand: the post-create body, the duplicate merge body, tag display names, download progress text, pacing/backoff. Give them one owner (a shared module both build from, or a backend import endpoint both call) so a fix lands once.** · import flow · evidence: `siteImportPostBody`, `downloadProgressText` in `browser-extension/site-import-core.js`; `mergeDuplicate`, `importAll` in `browser-extension/site-import.js`; `importPostBody`, `mergePostBody`, `downloadProgressText` in `frontend/src/remote/useImportQueue.js` · UNCLAIMED
