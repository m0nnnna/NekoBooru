# Repository hygiene - open queue

The repository itself: the test suites and their known failures, gates, the
build and `frontend/dist`, packaging, docs, the 800-line file ceiling, shared
frontend/backend plumbing, dev tooling, and dead code. Rows: one line and a
pointer (`- [ ] **what** · area · evidence · status`); claim with
`**TAKEN <date> <who>**` before starting; the landing commit deletes the row.
Where a row and its evidence disagree, the evidence wins.

## Open

- [ ] **Eleven source files exceed the 800-line ceiling; split each by functionality into 200-800-line components/composables/modules, behaviour-preserving, the way Stage 0 split `HomeView.vue` (3,432 -> 382). Largest first: `SettingsView.vue` 5,437, `PostView.vue` 5,120, `auto_tagger.py` 4,756, `browser-extension/upload.js` 2,644, `browser-extension/background.js` 1,678, `routers/posts.py` 1,515, `UploadView.vue` 1,374, `services/upload_jobs.py` 1,198, `browser-extension/site-import-core.js` 1,074, `routers/uploads.py` 1,018, `browser-extension/track-cursor.js` 883. One lane per file; `auto_tagger.py` and the frontend views are each a single lane (CLAUDE.md rule 2).** · file size · evidence: `wc -l` on main 2026-10-13; template `25571e4` · UNCLAIMED
- [ ] **Two backend tests fail on a clean tree, so every lane has to remember which reds are "known" - fix them or mark them expected-failure with the reason: `test_extension_upload_defaults_can_be_saved` and `test_disabled_preview_preserves_tags_without_provenance`.** · test suite · evidence: `tests/test_auto_tags.py` (both fail with the working tree stashed, 2026-10-03 and every merge since) · UNCLAIMED
- [ ] **`request()` in the API client throws away response headers and turns network failures into a status-less `Error`, so callers cannot read `Retry-After` and can only recognise "offline" by a missing status. Return a typed error (`status`, `kind: 'http'|'network'|'aborted'`, `retryAfterMs`, `detail`) and use it in the booru adapters and import queue.** · shared frontend plumbing · evidence: `request` in `frontend/src/api/client.js`; the `network`/`retryAfterMs` workarounds in `frontend/src/remote/adapters/*.js` and `frontend/src/remote/useImportQueue.js` · UNCLAIMED
- [ ] **`frontend/src/api/client.js` is at 793 lines and was compacted to fit P2a's additions; split it by domain (posts, tags, uploads, auto-tags, auth, booru search) before the next addition breaks the ceiling.** · shared frontend plumbing · evidence: `frontend/src/api/client.js`, P2a commit `deb6b33` · UNCLAIMED
