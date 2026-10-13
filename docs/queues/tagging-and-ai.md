# Tagging and AI - open queue

Auto-tagging models and jobs, tag categories, aliases, implications, bulk tag
edits. Rows: one line and a pointer (`- [ ] **what** · area · evidence · status`);
claim with `**TAKEN <date> <who>**` before starting; the landing commit deletes
the row. Where a row and its evidence disagree, the evidence wins.

## Open

- [ ] **One AI model's flag list is hand-copied into five places, so adding a tagger means editing all five and missing one silently skips the model in that surface. Give the model registry one owner the frontend and extension read (e.g. served from `/api/auto-tags/status` or a shared module), and derive the per-view key lists and profile defaults from it.** · AI model registry · evidence: CLAUDE.md "Adding a new tagger model" steps 9-13; `aiModelDefaultKeys` in `frontend/src/composables/useBatchAiTagging.js`, the model lists in `frontend/src/views/SettingsView.vue`, `PostView.vue`, `UploadView.vue`, `browser-extension/upload.js` · **TAKEN 2026-10-13 W2b-registry**
