# Gallery and search - open queue

The home gallery, library search, the post page's display, and browsing other
boorus. Rows: one line and a pointer (`- [ ] **what** · area · evidence · status`);
claim with `**TAKEN <date> <who>**` before starting; the landing commit deletes
the row. Where a row and its evidence disagree, the evidence wins.

## Open
- [ ] **Sankaku `preview_url`s are signed and expire (~8 h, `expires=` param), so a result page left open shows broken thumbs; refetch the page or refresh the post when a thumb errors after expiry.** · booru search · evidence: `preview_url` mapping in `frontend/src/remote/adapters/sankaku.js`, anonymous GET 2026-10-13 · **TAKEN 2026-10-13 W2a-tagmap**
- [ ] **PostView's page-wide `.loading, .error` rule also gave `.optimize-job-card.error`, `.post-optimize-status.error` and `.online-search-message.error` 3rem padding and centred text; it is now carried along in the two panels to keep the look - limit it to the loading / not-found states and drop the copies.** · frontend · evidence: style tails of `frontend/src/components/post/PostOptimizePanel.vue` and `PostOnlineSearchPanel.vue` (`8bdaca0`) · **TAKEN 2026-10-13 W2b-registry**
- [ ] **The global `.btn` has no disabled style, so disabled buttons app-wide look clickable; only the pager (`3b0b0ee`) and a few cards (`batchForms.css`, `PostOptimizePanel`) style it locally. Add one `.btn:disabled` rule in App.vue and drop the local copies.** · frontend theme · evidence: `.btn` in `frontend/src/App.vue`; `.batch-actions-row .btn:disabled` in `components/batch/batchForms.css`; `.optimize-action-bar .btn:disabled` in `components/post/PostOptimizePanel.vue` · UNCLAIMED
