# Aggregated booru search with hold-to-select importing

Status: draft plan, decisions agreed with the owner. To be made
implementation-ready (API contracts, module interfaces, work packages) before
the build stages start.

## Goal

The home search can show results from other boorus next to (or instead of) the
library, and hold-to-select works as an interactive scraper: select remote
posts, import them into NekoBooru at original resolution with their tags.

## Agreed decisions

1. **Sources** - a button with a checkbox dropdown next to the home search bar.
   NekoBooru (the library) is ticked by default; ticking more boorus aggregates
   them. Sources: NekoBooru, Danbooru, Gelbooru, Safebooru, e621/e926, Sankaku.
2. **Layout** - grouped by source by default (a section per source with its own
   header, count and paging); a toggle switches to one interleaved feed.
   Remote posts carry a site badge.
3. **Mixed selection** - one batch panel split by kind: "N selected · X library
   · Y remote". The Import card acts on remote posts; the existing tools
   (tag edit, pools, delete, AI) act on library posts only and show their
   count. Delete never touches remote posts. Imported posts stay selected as
   library posts so edits can be chained.
4. **Images** - loaded straight from each booru in the browser: the booru's
   small preview in the grid, the original on click. `referrerpolicy="no-referrer"`
   on every remote image (Sankaku's CDN returns 403 when the referer is the
   NekoBooru origin, 200 with none). A failed image shows a placeholder with
   the post id. Imports still download server-side.
5. **Search transport**
   - Browser-direct (the API sends `Access-Control-Allow-Origin`): Danbooru
     (`*`), e621 (`*`; browsers cannot set User-Agent, so send
     `_client=NekoBooru/1.0`), Sankaku (`sankakuapi.com`, echoes the origin;
     the old `capi-v2.sankakucomplex.com` returns 403).
   - Server relay (no CORS header even on 200 responses): Gelbooru (also needs
     the API key saved in server settings, which must not reach browsers on a
     multi-user instance) and Safebooru.
6. **Query** - plain tags go to every source unchanged. The gallery's rating
   checkboxes and sort order are translated per site (`safety:` -> Danbooru
   `rating:g/s/q/e`, Gelbooru `rating:general/sensitive/questionable/explicit`,
   e621 `rating:s/q/e`, ...). Other site-specific metatags are sent only where
   understood; the section header notes what was ignored.
7. **Paging** - grouped: each remote section has its own "Load more"; the
   library section keeps page numbers. Interleaved: "Load more" pulls the next
   batch from every ticked source. Each source keeps its own cursor (page
   number, or Sankaku's keyset `next`).
8. **Tag spelling** - searches are sent as typed. On import, tags are
   converted to Danbooru spelling (as the Sankaku extension import already
   does via `POST /api/site-imports/danbooru-names`) and the source spelling
   is kept as a tag alias.
9. **Import defaults** - original file; the booru's tags with categories; the
   booru's rating; AI tagging off by default (switch in the Import card); the
   booru post URL as the source; optional extra tags, rating override, pool.
10. **Rate limits** - imports run one at a time with a 1.5 s gap and
    10/30/60 s backoff on 429/503 (as the extension's search-page imports do);
    typing searches only after a ~500 ms pause; a small request budget per
    source.
11. **Clicking a remote post** - opens a viewer over the grid (full-res, tags
    by category, rating, size, booru link, Import button). No navigation.
12. **Already imported** - "in library" badge linking to the local copy. In
    interleaved mode with NekoBooru ticked, the remote duplicate is hidden.
13. **Persistence** - ticked sources and the grouped/interleaved mode are saved
    per browser and mirrored in the URL (`?sources=nekobooru,danbooru`).
14. **Filtering** - the rating checkboxes apply to remote results. Booru-side
    account blacklists don't apply (the app isn't logged in to them); a
    per-source tag blacklist is a later idea.

## Per-booru facts

| Booru | Search | Images | Import path | Tag categories |
|---|---|---|---|---|
| Danbooru | browser-direct | direct | existing (`from-url` + `POST /api/posts`) | in search results (`tag_string_*`) |
| e621 / e926 | browser-direct, `_client=` | direct | new (same steps) | mapped: species -> general, lore -> meta, contributor -> artist |
| Sankaku | browser-direct (`sankakuapi.com`) | direct, no referrer required | existing | in search results (type numbers) |
| Gelbooru | server relay (extend `POST /api/site-imports/gelbooru-search`) | direct | existing | looked up at import (cached a day) |
| Safebooru | server relay (new) | direct | existing | not available - general only |

Notes:

- Danbooru's CDN (Cloudflare) 403s a browser User-Agent sent from a non-browser
  client; `from-url` already sends `NekoBooru/1.0 (original importer)` for
  `*.donmai.us`. e621's file hosts need the same.
- Sankaku's API hides some members-only posts without a login token; the web
  app has none (a Settings field is a later idea). Its image URLs are signed
  and expire within hours; imports fetch a fresh URL.

## Constraints

- Every file at most 800 lines; new modules aim for 200-800 lines, grouped by
  functionality (small composables are fine when genuinely self-contained).
- Follow CLAUDE.md: no absolute paths, AI deps stay optional, match style,
  no new dependencies, `frontend/dist/` rebuilt and committed separately.
- Multi-agent work: each agent in its own worktree; integrate with
  `git merge --ff-only` after rebasing and re-running tests; frontend work
  touching shared files is serialized.

## Stages

0. **Groundwork** (in progress) - split `frontend/src/views/HomeView.vue`
   (3,432 lines) into components/composables, redesign the hold-to-select
   panel, and leave it ready for string selection keys (`danbooru:123`) and a
   new Import card.
1. **Backend** - Gelbooru search relay (extend the existing endpoint: full
   results page with preview URLs, categories only at import); Safebooru
   search relay; "already in library" lookup (keys -> local post ids via
   `<site>_<id>` tags); e621 hosts in the honest User-Agent rule; tests.
2. **Frontend adapters** (no UI) - `frontend/src/remote/`: one adapter per
   booru normalizing results to a common post shape; query translation;
   per-source cursors; per-source request budget; vitest tests against saved
   real responses.
3. **Search UI** - source dropdown; results composable (grouped/interleaved,
   Load more); remote post card (badge, in-library, no-referrer, placeholder);
   remote viewer; string-keyed hold-to-select across sections.
4. **Importing** - Import card; import queue (pacing, backoff, skip-existing
   with tag merge, Danbooru spelling + aliases, Gelbooru categories at import);
   imported posts swap to library selection.
5. **Finish** - README, full tests on `main`, `dist` rebuild, browser check.

Stage 1 and Stage 2 can run in parallel; Stages 3 and 4 touch the home view
and run after Stage 0 is merged.
