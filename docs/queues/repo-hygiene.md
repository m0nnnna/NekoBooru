# Repository hygiene - open queue

The repository itself: the test suites and their known failures, gates, the
build and `frontend/dist`, packaging, docs, the 800-line file ceiling, shared
frontend/backend plumbing, dev tooling, and dead code. Rows: one line and a
pointer (`- [ ] **what** · area · evidence · status`); claim with
`**TAKEN <date> <who>**` before starting; the landing commit deletes the row.
Where a row and its evidence disagree, the evidence wins.

## Open
- [ ] **`tests/test_auto_tags.py` is 2,515 lines; split it by area (API, options/semantic, downloads/loads, ONNX/runtime) into test files under 800.** · test suite · evidence: `tests/test_auto_tags.py` · UNCLAIMED
- [ ] **The split backend modules keep imports they no longer use, and `utils/module_split.mirror_rebinding` mirrors patches, only so tests patching the old paths still resolve; move the tests' patches to the new modules, then prune the imports and retire the shim.** · backend · evidence: `routers/posts.py`, `routers/uploads.py`, `services/upload_jobs.py`, `services/auto_tagger/__init__.py`, `backend/app/utils/module_split.py` (L4 split commits) · UNCLAIMED
- [ ] **Settings section components each carry their own copy of the shared form rules (toggle-card, form-actions, cookies-status, config-panel, field-row, info-icon...): the SettingsView CSS chunk went from 30 KB to 58 KB; move the shared rules into one `components/settings/settingsForms.css`, as `batchForms.css` does.** · frontend · evidence: `frontend/src/components/settings/*.vue` (`5391e72`) · UNCLAIMED
- [ ] **Unused leftovers moved into the post/settings splits: the `.saved-analysis-card/-body/-tags/-editor/-actions/-edit` rules (only `.saved-analysis-error` is used), the `aiSetupTarget` ref, and `whisperEnabled: !isAnime ? true : true` in `hydrateProfileDefaults`.** · frontend · evidence: `PostSemanticDescription.vue`, `useSettingsRuntime.js`, `useSettingsAiModels.js` · UNCLAIMED
