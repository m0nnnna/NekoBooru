# Gallery and search - open queue

The home gallery, library search, the post page's display, and browsing other
boorus. Rows: one line and a pointer (`- [ ] **what** · area · evidence · status`);
claim with `**TAKEN <date> <who>**` before starting; the landing commit deletes
the row. Where a row and its evidence disagree, the evidence wins.

## Open
- [ ] **The global `.btn` has no disabled style, so disabled buttons app-wide look clickable; only the pager (`3b0b0ee`) and a few cards (`batchForms.css`, `PostOptimizePanel`) style it locally. Add one `.btn:disabled` rule in App.vue and drop the local copies.** · frontend theme · evidence: `.btn` in `frontend/src/App.vue`; `.batch-actions-row .btn:disabled` in `components/batch/batchForms.css`; `.optimize-action-bar .btn:disabled` in `components/post/PostOptimizePanel.vue` · **TAKEN 2026-10-13 W3-postpage**
- [ ] **RemotePostCard shows a broken thumb once a Sankaku signed preview expires; on `@error`, if `adapter.thumbExpired?.(post)` call `adapter.refreshThumb(post)` once and swap `post.thumbUrl`, else show the placeholder.** · booru search · evidence: `@error="failed = true"` in `frontend/src/components/remote/RemotePostCard.vue`; adapter hooks `sankakuAdapter.thumbExpired`/`refreshThumb` (`58a79d1`) · **TAKEN 2026-10-13 W3-postpage**
- [ ] **The post tag sidebar never passes a stored e621 name to TagSearchMenu, so each new page view's first e621 click makes a backend round trip; add `e621Name` to `tag_detail_dict` and the posts tag query, and pass `:e621-name` from TagSidebar like `sankakuName`.** · tags · evidence: `tag_detail_dict` in `backend/app/models/post.py`, the `Tag.sankaku_name` select in `backend/app/routers/posts.py`, `frontend/src/components/TagSidebar.vue`; prop added in `2f14341` · **TAKEN 2026-10-13 W3-postpage**
- [ ] **The aggregated search maps only qualified terms through the qualifier expansions, but library tag names are stored flattened (`honoka_doa`), so a term typed from the library never matches the qualified pattern; map the term's display spelling (or un-flatten through the tag's displayName) before resolving.** · booru search · evidence: `qualifierOf` in `frontend/src/remote/e621Names.js`, `lookupSankakuName` in `frontend/src/remote/adapters/sankaku.js` (`58a79d1`) · **TAKEN 2026-10-13 W3-postpage**
