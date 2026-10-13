# Gallery and search - open queue

The home gallery, library search, the post page's display, and browsing other
boorus. Rows: one line and a pointer (`- [ ] **what** · area · evidence · status`);
claim with `**TAKEN <date> <who>**` before starting; the landing commit deletes
the row. Where a row and its evidence disagree, the evidence wins.

## Open

- [ ] **Dark mode leaves un-coloured text dark on a dark background app-wide: `.dark-mode` sits on `#app`, but the global `body { color: var(--text-primary) }` resolves against the light palette, so any element without its own colour inherits dark text. The batch panel was patched locally; the root fix is setting the text colour on `#app` (or moving the theme class to `body`) and auditing views that patched around it.** · frontend theme · evidence: `frontend/src/App.vue` (`.dark-mode` root class), `frontend/src/components/batch/BatchPanel.vue` (local colour patch), Stage 0 redesign `058d74a` · UNCLAIMED
- [ ] **Remote section `totalPages` ignores each booru's anonymous paging cap (Danbooru 1000, e621 750, Gelbooru 20000/limit, Safebooru 500), so "page 3 of 4000" can show pages Load more will never reach; cap it per site.** · booru search · evidence: `updatePages` in `frontend/src/remote/useRemoteResults.js`, `DANBOORU_PAGE_CAP`/`E621_PAGE_CAP`/`SAFEBOORU_MAX_PAGE`/gelbooru `MAX_PAGE` in `frontend/src/remote/adapters/` · UNCLAIMED
- [ ] **Sankaku spends two of its four anonymous terms on `-rating:q -rating:e` when only safe is ticked; one `rating:s` term would do the same, so the rating filter would not crowd out tags.** · booru search · evidence: `ratingTerms` and `SANKAKU_TERM_LIMIT` in `frontend/src/remote/queryTranslation.js` · UNCLAIMED
- [ ] **`useRemoteSourcesStore.syncRoute()` rewrites `?sources`/`?layout` on whatever route is current; guard it to the home route once P3b wires it.** · booru search · evidence: `syncRoute` in `frontend/src/stores/remoteSources.js` · UNCLAIMED
