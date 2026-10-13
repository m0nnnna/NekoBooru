# Aggregated booru search with hold-to-select importing

Status: implementation-ready specification. The product decisions in
"Agreed decisions" are settled with the owner and are not reopened here; every
other section exists so that an implementing agent, given only this document
and the repository, has nothing left to guess.

Conventions used below: repo-relative paths only; "Stage 0" is the HomeView
split that is being merged separately (see "Home view integration"); JSON
shapes are given as JS object literals with JSDoc-style comments; every new
file lists a line budget (hard maximum 800 lines per file).

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
15. **Admin gate** - the whole feature sits behind an instance-wide,
    admin-only setting ("Enable booru search"), OFF by default and shown in
    Settings only to admin accounts. When OFF: the source dropdown is not
    rendered for anyone, the home view behaves exactly as today, and every new
    backend endpoint of this feature answers 403. When ON: every logged-in
    user can browse and import. The existing extension endpoints
    (`POST /api/site-imports/gelbooru-search`, `GET /api/site-imports/gelbooru/{id}`,
    `POST /api/site-imports/danbooru-names`) keep working regardless of the
    flag. The permission is computed in exactly one backend function and
    reaches the frontend only as a per-user capability (`canBrowseBoorus`),
    never as the raw instance setting, so per-user access can be added later
    without touching any endpoint or UI code.

---

## 1. Verified external API facts

Verification method: one small request per endpoint on 2026-10-13 with
`User-Agent: NekoBooru/1.0 (plan research)` and `Origin: http://localhost:5173`.
"Verified" means observed live; "from code" means taken from existing repo code
(`backend/app/services/site_imports.py`, `booru_suggest.py`,
`online_image_search.py`, `browser-extension/booru-tags.js`,
`browser-extension/site-import-core.js`); "docs" means public API documentation
not re-checked live. Nothing here used or looked for the owner's credentials.

### 1.1 Summary table

| | Danbooru | e621 / e926 | Sankaku | Gelbooru | Safebooru |
|---|---|---|---|---|---|
| Search URL | `https://danbooru.donmai.us/posts.json` | `https://e621.net/posts.json` (e926: same ids, safe subset) | `https://sankakuapi.com/posts/keyset` | `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1` | `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1` |
| Query params | `tags`, `page` (1-based), `limit` | `tags`, `page` (1-based, or `b<id>`/`a<id>`), `limit`, `_client` | `tags`, `limit`, `next` (opaque keyset cursor) | `tags`, `pid` (0-based page index), `limit`, `user_id`, `api_key` | `tags`, `pid` (0-based page index), `limit` |
| Max `limit` | 200 (docs) | 320 (docs) | 100 (verified: `limit=100` returned 100) | 100 (docs; code uses 42 = site page size) | 100 (docs; 1000 is the dapi hard cap) |
| Anonymous paging cap | page <= 1000 (docs) | page <= 750 (docs) | keyset `next` until `meta.next` is null | `pid` <= 20000/limit (docs: offset cap 20000) | none documented |
| Anonymous tag limit | **2 search terms, metatags included** (verified: 3 terms -> HTTP 422 `PostQuery::TagLimitError`) | 40 (docs) | 4 for anonymous (docs; unverified) | none documented | none documented |
| Response | JSON array of posts | `{"posts": [...]}` | `{"meta": {"next","prev"}, "data": [...]}` | `{"@attributes": {"limit","offset","count"}, "post": [...]}` (from code; `post` may be a single object or absent) | bare JSON array (verified) |
| CORS | `access-control-allow-origin: *` (verified) | `*` (verified) | echoes the `Origin` header (verified) | none, and HTTP 401 without a key (verified) | none on 200 (verified) |
| Transport | browser | browser | browser | server relay | server relay |
| Auth | none for public posts | none; `_client` identifies the app | none; some posts hidden for anonymous callers | `user_id` + `api_key` required for dapi (verified 401 without) | none |
| Rate limit (docs) | ~10 req/s burst, be polite | hard 2 req/s; identify client | undocumented; 429 observed historically | undocumented | undocumented |

### 1.2 Danbooru (verified live)

Post fields used: `id` (int), `md5`, `rating` (`g`/`s`/`q`/`e`), `image_width`,
`image_height`, `file_ext`, `file_size`, `source`, `created_at`, `score`,
`is_deleted`, `is_banned`, `is_pending`, `tag_string_general`,
`tag_string_artist`, `tag_string_copyright`, `tag_string_character`,
`tag_string_meta`, `preview_file_url` (180x180 jpg), `large_file_url` (sample
jpg, or the original when no sample exists), `file_url` (original),
`media_asset.variants[]` (`180x180`, `360x360`, `720x720`, `sample`, `original`
each with `url`, `width`, `height`, `file_ext`).

- Thumbnail: `media_asset.variants` entry of type `360x360` when present,
  else `preview_file_url`. Viewer: `file_url` (for `file_ext == "zip"` -
  ugoira - use `large_file_url`, which is Danbooru's webm; mirrors
  `danbooruImportJob`). Sample for a quicker viewer first frame:
  `large_file_url`.
- Category mapping (from the tag_string_* fields, no numbers involved):
  general -> general, artist -> artist, copyright -> copyright, character ->
  character, meta -> meta. Danbooru's numeric categories elsewhere are 0
  general, 1 artist, 3 copyright, 4 character, 5 meta (from code).
- Rating -> safety: `g` -> safe, `s` -> sketchy, `q` -> sketchy, `e` -> unsafe
  (matches `booruImportSafety` in `browser-extension/site-import-core.js`).
- Deleted posts: `is_deleted: true` but all file URLs still present
  (verified). Banned posts: `is_banned: true` and **no** `file_url` /
  `preview_file_url` / `large_file_url` / `md5` keys at all (verified). Gold-only
  posts (censored tags) look like banned ones to anonymous callers: the URL
  keys are absent (from code comments; not re-verified). Rule: missing or
  empty `preview_file_url` -> placeholder card; missing `file_url` ->
  `unavailable` set and Import disabled.
- Tag limit: anonymous queries may contain **two** terms total; `rating:`,
  `order:` and plain tags all count (verified with `cat_ears blue_archive
  rating:g,s order:id` -> 422). Error body:
  `{"success":false,"error":"PostQuery::TagLimitError","message":"You cannot search for more than 2 tags at a time."}`.
  The adapter must surface `message`.
- Rating metatag accepts a comma list (`rating:g,s`; docs). Sort metatags:
  `order:id` (ascending), `order:id_desc`, `order:filesize`,
  `order:filesize_asc` (docs).
- CDN (`cdn.donmai.us`, Cloudflare) refuses a browser User-Agent sent from a
  non-browser TLS fingerprint (403) but serves `NekoBooru/1.0 (original
  importer)`; `backend/app/routers/uploads.py` `_media_user_agent()` already
  does this for `*.donmai.us` (from code).

### 1.3 e621 / e926 (verified live)

Post fields used: `id`, `file.{width,height,ext,size,md5,url}`,
`preview.{width,height,url}` (jpg), `sample.{has,width,height,url}`, `tags.{general,
artist, contributor, copyright, character, species, invalid, meta, lore}`
(arrays of strings), `rating` (`s`/`q`/`e`), `sources` (array), `score.total`,
`created_at`, `flags.{deleted,pending,flagged}`.

- Thumbnail: `preview.url`; viewer: `file.url`; sample: `sample.url` when
  `sample.has`.
- Category mapping: general -> general, artist -> artist, contributor ->
  artist, copyright -> copyright, character -> character, species -> general,
  lore -> meta, meta -> meta, invalid -> dropped. (The draft's table; note
  `browser-extension/booru-tags.js` maps lore -> general - this feature keeps
  the draft's lore -> meta, and that is the only intentional difference.)
- Rating -> safety: `s` -> safe, `q` -> sketchy, `e` -> unsafe.
- Deleted posts: `flags.deleted: true` and `file.url`, `preview.url`,
  `sample.url` are `null` (verified). Posts hidden by the default anonymous
  blacklist also come back with `null` URLs (docs). Rule: `preview.url` null
  -> placeholder; `file.url` null -> unavailable.
- Browser requests cannot set `User-Agent`; e621 asks clients to identify
  themselves via `_client=<name>` (docs) - send `_client=NekoBooru/1.0` on
  every browser request. The server-side downloader must send an honest UA
  to `static1.e621.net` / `static1.e926.net` (see section 2.6).
- Query syntax mirrors Danbooru: `-tag`, `~tag`, `rating:s`, `-rating:e`,
  `order:id`, `order:id_desc`, `order:filesize`, `order:filesize_asc`,
  `md5:`, `width:>=`, `height:>=` (docs). e926 serves only safe posts; the
  adapter searches `e621.net` and labels the source "e621 / e926"; the import
  id tag is `e621_<id>` for both hosts because the ids are shared (from code:
  `browser-extension/booru-tags.js` treats both hosts as site `e621`).
- Rate limit: hard limit of 2 requests per second (docs); 429 when exceeded.

### 1.4 Sankaku via `sankakuapi.com` (verified live)

Endpoints: `GET /posts?tags=&limit=` (array) and `GET /posts/keyset?tags=&limit=&next=`
(`{"meta": {"next": "<hex>", "prev": null, "page_count": 0}, "data": [...]}`).
Use **keyset**; `meta.next` is the cursor for the next request, null/absent
when exhausted. `GET /posts/<id>` returns one post (from code).

Post fields used: `id` (alphanumeric string, e.g. `zjrmd0QxWaD`), `rating`
(`s` = safe, `q`, `e`), `status` (`active`, ...), `preview_url` (avif, signed),
`preview_width/height`, `sample_url` (webp, signed), `sample_width/height`,
`file_url` (signed original), `width`, `height`, `file_size`, `file_ext`,
`file_type` (MIME), `md5`, `source`, `created_at.s` (unix seconds),
`tags[]` with `tagName` (underscore form), `name_en`, `type` (int),
`redirect_to_signup` (bool), `is_premium`.

- Signed URLs carry `e=`/`expires=` (unix seconds; observed ~9 hours ahead)
  and `token=`. They expire; the import queue must call `GET /posts/<id>` for a
  fresh `file_url` right before downloading (adapter `refresh()`).
- Tag type -> category (from `SANKAKU_TYPE_TO_CATEGORY` in
  `browser-extension/site-import-core.js`): 0 general, 1 artist, 2 studio ->
  artist, 3 copyright, 4 character, 5 genre -> general, 8 medium -> meta,
  9 meta -> meta; any other number -> general. Tag name: `tagName`, falling
  back to `normalizeTagName(name_en)`.
- Rating -> safety: `s` -> safe, `q` -> sketchy, `e` -> unsafe (from code:
  `sankakuSafety`).
- Hidden posts: anonymous answers omit or null `file_url` on some posts
  (members-only / premium), often with `redirect_to_signup: true`;
  `preview_url` may still be present. Rule: no `file_url` -> unavailable with
  the message "Sankaku shows this original only to logged-in users".
- CORS: `Access-Control-Allow-Origin` echoes the request origin; the CDN
  (`v.sankakucomplex.com`, `s.sankakucomplex.com`) answers a NekoBooru-origin
  referer with 403 but a missing referer with 200 (draft, previously
  verified) - hence `referrerpolicy="no-referrer"`. The server-side downloader
  must keep sending `Referer: https://sankaku.app/` (already in
  `_media_referer()`).
- Sort/OR metatags are **unverified** on Sankaku; the adapter sends only plain
  tags, negations, `rating:`, `md5:`, `width:`/`height:` and treats everything
  else as ignored (section 3.3). Default order is newest first.
- Post page URL: `https://sankaku.app/posts/<id>` (from code).

### 1.5 Gelbooru dapi (from code + docs; 401 without key verified)

Post fields used (from `site_imports.py` and `online_image_search.py`):
`id`, `md5`, `rating` (`general`/`sensitive`/`questionable`/`explicit`), `width`,
`height`, `file_url`, `sample_url`, `preview_url`, `tags` (space-separated
string, no categories), `source`, `created_at`, `score`, `image` (filename),
`sample` (0/1), `status` (docs: `active`/`deleted`/`pending`).

- Response wrapper `{"@attributes": {"limit": 42, "offset": 0, "count": N}, "post": [...]}`;
  `post` can be a single object or absent when empty - use `_rows(payload, "post")`.
  `count` is the total matching posts.
- Categories are not in search results. `page=dapi&s=tag&q=index&json=1&names=<space list>&limit=<n>`
  returns `{"tag": [{"name","type","count",...}]}` with numeric types mapped by
  `TAG_TYPE_TO_CATEGORY` (0 general, 1 artist, 3 copyright, 4 character, 5
  meta, 6 deprecated -> meta). `_tag_categories()` already batches 80 names
  per call and caches a day - reuse it (section 2.5).
- Rating -> safety: `explicit`/`e` -> unsafe, `questionable`, `sensitive`,
  `q`, `s` -> sketchy, anything else -> safe (from code `_safety`).
- Query syntax: `-tag`, `rating:general`, `-rating:explicit`, `sort:id:asc`,
  `sort:id:desc`, `md5:`, `width:>=1000` (docs).
- Needs `user_id` + `api_key` (verified 401 without; existing code raises
  `PermissionError` when unconfigured). Credentials come from
  `booru_suggest.gelbooru_credentials()`; they never leave the server.
- Deleted/hidden posts: dapi does not return deleted posts in searches; a
  returned row without `file_url` (observed in extension imports) ->
  unavailable.
- No CORS header on any response (verified on the 401; draft verified on
  200), so a relay is mandatory.
- Preview thumbnails `https://img3.gelbooru.com/thumbnails/..` load fine in
  browsers without a referer (draft).

### 1.6 Safebooru dapi (verified live)

Post fields used: `id`, `hash` (md5), `rating` (`general` observed; older
rows use `safe`/`questionable`), `width`, `height`, `file_url`, `sample_url`,
`preview_url`, `sample` (bool), `tags` (space-separated string), `source`,
`change` (unix seconds), `score`, `status`, `owner`, `image`, `directory`.

- Response is a bare JSON array; empty result is `[]` or an empty body -
  treat a non-array as `[]`. The JSON has no total count; the XML answer's
  `<posts count="N">` does, which the relay reads (section 2.4). Without it,
  "more pages exist" means the page came back full.
- Categories: **not available**. The dapi tag endpoint
  (`s=tag&q=index&names=...&json=1`) answers XML and ignores `names`
  (verified), so Safebooru imports stay general-only as the draft says (see
  open question 1 for the optional Danbooru-based resolver).
- Rating -> safety: `general`/`safe`/`g`/`s` -> safe, `sensitive`/`questionable`/`q`
  -> sketchy, `explicit`/`e` -> unsafe.
- Query syntax as Gelbooru (`-tag`, `rating:`, `sort:id:asc`, `md5:`).
- No CORS header (verified) -> relay. No auth. No documented rate limit; the
  relay keeps the same budget as Gelbooru.
- Post page URL: `https://safebooru.org/index.php?page=post&s=view&id=<id>`.

### 1.7 Shared facts

- NekoBooru flattens tag names (`backend/app/services/tagging.py`
  `normalize_tag`): anything but letters, digits, `_ : . -` becomes `_`,
  runs collapse, ends trimmed. The frontend twin is `normalizeTagName()` in
  `frontend/src/utils/booruSearchTag.js`. A tag whose booru spelling differs
  from its flattened form (`miyu_(blue_archive)` -> `miyu_blue_archive`)
  must carry `tagDisplayNames[flat] = "miyu (blue archive)"` on import, exactly
  as `booruDisplayNames()` in `browser-extension/site-import-core.js` does.
- Every booru import carries the id tag `<site>_<id>` with category `meta`:
  `danbooru_123`, `gelbooru_123`, `safebooru_123`, `sankaku_zjrmd0QxWaD`,
  `e621_123`. The "in library" lookup is keyed on these.
- Danbooru spelling of qualified character/copyright tags is resolved by
  `POST /api/site-imports/danbooru-names` (existing, unchanged).

---

## 2. Backend API contracts

All new routes require a logged-in user (`get_current_user`) and, unless noted,
the booru-search capability (section 2.1). Error bodies follow the existing
convention: `{"detail": "<string>"}` for simple errors or
`{"detail": {"code": "<snake_case>", "message": "<text>"}}` when the frontend
must branch on the code. `frontend/src/api/client.js` already surfaces
`detail.message`/`detail.code` on thrown errors as `error.detail` and
`error.status`.

**Status codes reserved by this feature**

| Status | Meaning | Detail code |
|---|---|---|
| 403 | booru search disabled for this user/instance (the gate) | `booru_search_disabled` |
| 403 | non-admin writing the admin setting | plain string from `get_current_admin` ("Admin only") |
| 400 | bad parameters (empty keys list, bad page, too many keys) | plain string |
| 400 | Gelbooru credentials not configured | `gelbooru_credentials_missing` |
| 429 | upstream answered 429 or 503 (relay passes `Retry-After` through when present, else sets `Retry-After: 60`) | `upstream_throttled` |
| 502 | upstream unreachable / non-JSON / other HTTP >= 400 | `upstream_error` |

Never answer 401 from the new routes for anything but "not logged in":
`client.js` treats a 401 as a session loss and redirects to `/login`.

### 2.1 Permission gate (one function, one dependency)

New file `backend/app/services/booru_access.py` (budget 40-80 lines):

```python
from __future__ import annotations

from fastapi import Depends, HTTPException

from ..config import settings
from ..dependencies import get_current_user
from ..models import User
from .settings import SettingsManager

DISABLED_MESSAGE = "Booru search is disabled on this instance. An admin can enable it in Settings."


def booru_search_enabled() -> bool:
    """The instance-wide admin switch, read from settings.json."""
    return SettingsManager(settings.config_file).get_booru_search_settings().get("enabled") is True


def booru_search_allowed(user: User) -> bool:
    """The single place that decides whether ``user`` may browse and import from boorus.

    Today this is just the instance switch. Per-user access later means: a
    ``User.can_browse_boorus`` column, a checkbox on the admin Users page, and
    one more condition here - no endpoint or UI change.
    """
    return booru_search_enabled()


async def require_booru_search(current_user: User = Depends(get_current_user)) -> User:
    if not booru_search_allowed(current_user):
        raise HTTPException(status_code=403, detail={"code": "booru_search_disabled", "message": DISABLED_MESSAGE})
    return current_user
```

Rules: every new booru-search endpoint declares
`current_user: User = Depends(require_booru_search)` and nothing else reads the
setting. `User.to_dict()` is not changed; the capability is added in the `me`
route only (section 2.3).

### 2.2 Admin setting storage and endpoints

`backend/app/services/settings.py` gains, next to `get_extension_settings`:

```python
def get_booru_search_settings(self) -> dict:      # {"enabled": bool}; missing -> {}
def set_booru_search_settings(self, values: dict) -> None   # stores under key "booruSearch"
```

Stored in `settings.json` as `"booruSearch": {"enabled": false}`. Absent key
means disabled.

`backend/app/routers/settings.py` (prefix `/api/settings`) gains two routes,
both `Depends(get_current_admin)` (from `backend/app/dependencies.py`; a
non-admin gets 403 "Admin only", an anonymous caller 401):

```
GET  /api/settings/booru-search          -> {"enabled": false}
PUT  /api/settings/booru-search          body {"enabled": true}  -> {"enabled": true}
```

Request model `BooruSearchSettingsRequest(BaseModel): enabled: bool`. The PUT
writes `{"enabled": bool(request.enabled)}` and returns the stored value.

### 2.3 Per-user capability on `/api/auth/me`

`backend/app/routers/auth.py` `me()` adds one key to its payload:

```python
data["canBrowseBoorus"] = booru_search_allowed(current_user)
```

This is the only thing the frontend reads (`authStore.canBrowseBoorus`). After
an admin flips the switch, the Settings card calls `authStore.fetchMe()` so the
admin's own dropdown appears without a reload; other users see it on their
next page load.

### 2.4 Booru-search router

New router `backend/app/routers/booru_search.py` (budget 150-250 lines),
`APIRouter(prefix="/api/booru-search", tags=["booru-search"])`, registered in
`backend/app/main.py` after `site_imports.router`. New service
`backend/app/services/booru_search.py` (budget 250-400 lines) holds the HTTP
work so it is testable with `_fetch_json` patched, mirroring
`tests/test_site_imports.py`.

The existing `POST /api/site-imports/gelbooru-search` is **not** extended: it
resolves originals plus categories for a known list of ids (the extension's
search-page import) and is used verbatim by `browser-extension/site-import.js`.
The relay below is a different operation (a full results page, no categories,
gated). Leaving the old route untouched is what keeps the extension working.

#### `GET /api/booru-search/status`

Gate: logged-in only (**not** `require_booru_search`) - the UI needs it to
know what to render.

```js
// 200
{
  enabled: true,              // === authStore.canBrowseBoorus for this user; same function
  gelbooruConfigured: true,   // gelbooru_credentials() is not None
  sources: ['danbooru', 'e621', 'sankaku', 'gelbooru', 'safebooru'],  // fixed list, in display order
}
```

`enabled` is `booru_search_allowed(current_user)`; the frontend still reads
the capability from `/api/auth/me` and uses this route only for
`gelbooruConfigured` (to grey Gelbooru out with "needs an API key in Settings").

#### `GET /api/booru-search/gelbooru`

Query params: `tags` (string, default `""`, whitespace-collapsed, max 500
chars), `page` (int, 1-based, default 1, 1..500), `limit` (int, default 40,
1..100). Server computes `pid = page - 1`.

Upstream call: `GET https://gelbooru.com/index.php` with params
`{"page":"dapi","s":"post","q":"index","json":1,"tags":tags,"limit":limit,"pid":pid,"user_id":..,"api_key":..}`
through a `_fetch_json(params, timeout)` twin of `site_imports._fetch_json`
(httpx params, UA `NekoBooru/1.0 (booru search relay)`, 10 s timeout,
`follow_redirects=True`). The service **must not** format the key into a URL
string (the `booru_suggest` httpx log filter already redacts `api_key=`).

```js
// 200
{
  site: 'gelbooru',
  page: 1, limit: 40,
  total: 12345,          // @attributes.count, or null when absent
  posts: [ /* raw Gelbooru post rows, exactly as returned, nothing added */ ],
}
```

Errors: no credentials -> 400 `gelbooru_credentials_missing` ("Gelbooru needs
an API user id and key saved in Settings → AI auto-tagging → Gelbooru"). Upstream
401/403 -> 400 `gelbooru_credentials_missing` with message "Gelbooru rejected
the saved API credentials". Upstream 429/503 -> 429 `upstream_throttled`.
Network error / other >= 400 / invalid JSON -> 502 `upstream_error` with the
upstream status in the message.

The relay returns raw rows on purpose: normalisation lives in one place (the
frontend adapters, section 3), and the backend never has to learn the
frontend's post shape.

#### `GET /api/booru-search/safebooru`

Same params and envelope with `site: 'safebooru'`, upstream
`https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&tags=..&limit=..&pid=..`,
no credentials. The JSON answer has no count, so after the page succeeds the
relay asks the XML dapi once with `limit=0` and reads `<posts count="N">`;
that count is cached per tag string for 10 minutes and `total` is `null` when
the count request fails (it never fails the search). The Safebooru adapter
treats a number as exact and falls back to the short-page rule on `null`. A
non-array body is treated as `[]`.

#### `POST /api/booru-search/in-library`

```js
// request
{ keys: ['danbooru:12370916', 'e621:6776680', 'sankaku:zjrmd0QxWaD'] }   // 1..500 keys
// 200
{
  found: {
    'danbooru:12370916': { postId: 42 },     // only keys that are in the library; absent = not found
  },
}
```

Semantics: key `<site>:<id>` maps to tag name `<site>_<id>` (lower-cased,
`normalize_tag`-ed; invalid keys - unknown site, empty id, bad characters - are
skipped silently). Query: `Tag.name IN (...)` joined through `PostTag` to
`Post`, with `Tag.owner_id IN owner_ids`, `Post.owner_id IN owner_ids`
(`visible_owner_ids(db, current_user)` like `list_posts`) and
`Post.deleted_at IS NULL`. When several posts carry the tag, return the lowest
id. Soft-deleted copies count as "not in library" on purpose: an import then
hits the `409 duplicate_post` path of `POST /api/posts`, which restores and
merges exactly like the extension's `mergeDuplicate`. Site ids accepted:
`danbooru`, `e621`, `sankaku`, `gelbooru`, `safebooru`. 400 for an empty list
or more than 500 keys. Chunk the `IN` list at 200 names per statement.

#### `POST /api/booru-search/gelbooru-categories`

```js
// request
{ tags: ['templus', 'azur_lane', 'solo'] }      // 1..500 tag names
// 200
{ categories: { templus: 'artist', azur_lane: 'copyright', solo: 'general' } }
```

Delegates to `site_imports._tag_categories(tags, _auth_params(), timeout)`
(80-name batches, one-day cache, unknown tags -> `general`), so a Gelbooru page
of imports costs a handful of requests. Same credential errors as the relay.
Called by the import queue once per queue run for all queued Gelbooru posts
(section 3.7), never from the search path.

### 2.5 Reused existing routes (unchanged)

| Route | Used by | Notes |
|---|---|---|
| `POST /api/uploads/from-url` `{url, referer, progressId}` | import queue | returns `{token, filename, size, url}`; 400 "Failed to fetch URL: HTTP 429" carries the upstream status in the string, which the queue's backoff matches with `/HTTP (429\|503)\b/` like the extension; 409 "already downloading" |
| `GET /api/uploads/from-url/progress/{id}` | import queue | `{received, total, done}` polled every 1 s |
| `POST /api/posts` | import queue | body identical to `siteImportPostBody` (section 3.7); 409 `duplicate_post` detail `{code, message, post, postId, postUrl, sha256, deleted}` |
| `PUT /api/posts/{id}` `{tags, safety, source, tagCategories, tagDisplayNames}` | duplicate merge | as `mergeDuplicate` |
| `POST /api/posts/{id}/restore` | duplicate merge of a soft-deleted copy | as `mergeDuplicate` |
| `POST /api/site-imports/danbooru-names` `{tags, tagCategories}` -> `{renames}` | import queue (Sankaku and e621 posts) | not gated by the new switch |
| `POST /api/tag-aliases` `{alias, target, sankakuName?}` | import queue | 409 when the alias exists - ignore |
| `POST /api/pools/{id}/posts` `{postIds}` / `POST /api/pools` | Import card pool option | existing |
| `GET /api/auth/me` | capability | gains `canBrowseBoorus` (2.3) |

### 2.6 Honest User-Agent for e621 file hosts

`backend/app/routers/uploads.py`: add

```python
def _is_e621_host(host: str | None) -> bool:
    host = (host or "").lower()
    return host in {"e621.net", "e926.net"} or host.endswith((".e621.net", ".e926.net"))
```

and make `_media_user_agent()` return `DANBOORU_MEDIA_USER_AGENT`
(`"NekoBooru/1.0 (original importer)"`) for `_is_e621_host(host)` too; the
constant may be renamed `HONEST_MEDIA_USER_AGENT` with the old name kept as an
alias so nothing else breaks. e621's static hosts are `static1.e621.net` and
`static1.e926.net` (verified in the search response). Test: a unit test that
calls `_media_user_agent("static1.e621.net")` and `("cdn.donmai.us")` and
asserts the honest UA, and `("pbs.twimg.com")` the browser UA.

---

## 3. Frontend module design

All new frontend code lives under `frontend/src/remote/` (logic, framework-free
where possible, vitest next to each file) and `frontend/src/components/remote/`
(Vue). Nothing here imports from `HomeView.vue` or its Stage 0 children; the
dependency points the other way.

### 3.1 Site registry and keys - `frontend/src/remote/types.js` (budget 120-200)

```js
export const SITES = [
  { id: 'danbooru',  label: 'Danbooru',     transport: 'browser', homepage: 'https://danbooru.donmai.us', referer: 'https://danbooru.donmai.us/' },
  { id: 'e621',      label: 'e621 / e926',  transport: 'browser', homepage: 'https://e621.net',          referer: 'https://e621.net/' },
  { id: 'sankaku',   label: 'Sankaku',      transport: 'browser', homepage: 'https://sankaku.app',       referer: 'https://sankaku.app/' },
  { id: 'gelbooru',  label: 'Gelbooru',     transport: 'relay',   homepage: 'https://gelbooru.com',      referer: 'https://gelbooru.com/' },
  { id: 'safebooru', label: 'Safebooru',    transport: 'relay',   homepage: 'https://safebooru.org',     referer: 'https://safebooru.org/' },
]
export const LIBRARY_SOURCE = 'nekobooru'
export const SOURCE_IDS = [LIBRARY_SOURCE, ...SITES.map((s) => s.id)]   // display order
export const SAFETY_ORDER = ['safe', 'sketchy', 'unsafe']
export const CATEGORIES = new Set(['general', 'artist', 'copyright', 'character', 'meta'])

export function makeKey(site, id) { return `${site}:${id}` }            // 'danbooru:123'
export function splitKey(key) { /* -> { site, id } or null; id may contain letters (Sankaku) */ }
export function isRemoteKey(key) { return typeof key === 'string' && splitKey(key)?.site !== LIBRARY_SOURCE }
export function libraryKey(postId) { return `${LIBRARY_SOURCE}:${postId}` }   // 'nekobooru:42'
export function libraryIdFromKey(key) { /* number or null */ }
export function idTagFor(post) { return `${post.site}_${post.id}` }        // 'danbooru_123'
export function stricterSafety(a, b) { /* same as extension's stricterSafety */ }
export function booruDisplayNames(rawTags) { /* same regex as site-import-core booruDisplayNames: raw -> display for tags with punctuation */ }
```

Selection keys are strings everywhere: remote `'<site>:<id>'`, library
`'nekobooru:<postId>'`. If Stage 0 chose a different convention for library
keys (for example bare numbers), the Stage 3 agent adapts
`libraryKey`/`libraryIdFromKey` to it; the remote key format is fixed.

### 3.2 Normalized remote post

Every adapter returns this exact shape (JSDoc `RemotePost` in `types.js`):

```js
{
  key: 'danbooru:12370916',     // makeKey(site, id)
  site: 'danbooru',
  id: '12370916',               // ALWAYS a string (Sankaku ids are alphanumeric)
  postUrl: 'https://danbooru.donmai.us/posts/12370916',
  thumbUrl: 'https://cdn.donmai.us/360x360/..jpg' | null,   // grid preview; null -> placeholder card
  sampleUrl: 'https://cdn.donmai.us/sample/..jpg' | null,    // optional mid-size for the viewer's first paint
  fileUrl: 'https://cdn.donmai.us/original/..png' | null,    // original; null -> unavailable, Import disabled
  width: 2723 | null, height: 3008 | null,                   // original dimensions (ints)
  fileExt: 'png' | '',                                       // lower-case, no dot
  mediaType: 'image' | 'gif' | 'video' | 'unknown',          // video: mp4 webm mov m4v zip(ugoira->webm); gif: gif
  fileSize: 1795595 | null,
  safety: 'safe' | 'sketchy' | 'unsafe',
  rawRating: 'g',                                            // the site's own letter/word
  tags: ['1girl', 'cat_ears', 'miyu_blue_archive'],          // normalizeTagName()-ed, deduped, NO id tag
  tagCategories: { '1girl': 'general', 'miyu_blue_archive': 'character' },   // every tag present, categories from CATEGORIES
  tagDisplayNames: { miyu_blue_archive: 'miyu (blue archive)' },             // only tags whose spelling flattened (booruDisplayNames)
  source: 'https://i.pximg.net/...' | null,                  // the booru's own source field (first of e621 sources)
  md5: '1afe4a4b32b9460b7ec9fe9b77390513' | null,
  score: 1 | null,
  createdAt: '2026-10-13T04:49:19.383Z' | null,              // ISO; Sankaku from created_at.s
  unavailable: null | 'hidden' | 'deleted' | 'banned' | 'no-file',  // why fileUrl is null
  referer: 'https://danbooru.donmai.us/',                    // sent to /api/uploads/from-url
}
```

Rules shared by all adapters: run every tag through `normalizeTagName()`
(`frontend/src/utils/booruSearchTag.js`), drop empties, dedupe preserving
order; a tag's category is the first category it appears under; `rawRating`
lower-cased; `mediaType` from `fileExt` (`gif` -> gif; `mp4 webm mov m4v zip`
-> video; `jpg jpeg png webp avif` -> image; else unknown). Never keep the raw
row on the object (memory). Gelbooru/Safebooru adapters normalise the raw rows
the relay returns.

### 3.3 Query translation - `frontend/src/remote/queryTranslation.js` (budget 250-400)

Input: the home view's query string exactly as the library receives it (the
`q` route param **without** the `-safety:` exclusions HomeView appends), plus
`options = { safety: {safe, sketchy, unsafe}, sort: 'date'|'id'|'size', order: 'asc'|'desc' }`.

`parseQuery(q)` tokenises on whitespace into `{ kind: 'tag'|'neg'|'or'|'meta', value, key?, op?, raw }`
where `meta` is `key:value` with `key` lower-cased and `op` one of
`'' '>' '>=' '<' '<='` (NekoBooru's `width:>=1000` syntax). Quoted multi-word
tags are not supported by the library search either, so they are not here.

`translateQuery(site, q, options) -> { tags: string, terms: string[], ignored: string[], clientSafetyFilter: boolean, note: string|null }`
is pure and fully unit-tested. Per-site tables:

**Rating** (from the unticked checkboxes; nothing is added when all three are ticked):

| Site | safe | sketchy | unsafe | Emitted as |
|---|---|---|---|---|
| danbooru | `g` | `s`,`q` | `e` | one `rating:<ticked letters comma-joined>` term |
| e621 | `s` | `q` | `e` | `-rating:<x>` per unticked letter |
| sankaku | `s` | `q` | `e` | `-rating:<x>` per unticked letter |
| gelbooru | `general` | `sensitive`,`questionable` | `explicit` | `-rating:<word>` per unticked word |
| safebooru | `general` | `questionable` | `explicit` | `-rating:<word>` per unticked word |

`clientSafetyFilter` is always `true`: the results composable also drops any
normalised post whose `safety` is unticked (sites with ambiguous ratings, and
Danbooru when the term budget forced the rating term out).

**Sort** (`sort`/`order` from the toolbar):

| Site | date/id desc (default) | date/id asc | size desc | size asc |
|---|---|---|---|---|
| danbooru, e621 | nothing | `order:id` | `order:filesize` | `order:filesize_asc` |
| gelbooru, safebooru | nothing | `sort:id:asc` | ignored (note "size sorting") | ignored |
| sankaku | nothing | ignored (note "oldest-first") | ignored | ignored |

**Terms:**

| Token | danbooru | e621 | sankaku | gelbooru | safebooru |
|---|---|---|---|---|---|
| plain tag | pass | pass | pass | pass | pass |
| `-tag` | pass | pass | pass | pass | pass |
| `~tag` | pass | pass | ignored | ignored | ignored |
| `*` wildcard inside a tag | pass | pass | pass | pass | pass |
| `safety:`/`rating:` (NekoBooru values safe/sketchy/unsafe, or the site's own) | folded into the rating term above (narrows the ticked set) | same | same | same | same |
| `md5:`/`hash:<32 hex>` | `md5:` | `md5:` | `md5:` | `md5:` | `md5:` |
| `width:`/`height:` with op | pass as `width:>=1000` | pass | pass | pass | pass |
| `sha256:`, `fav:`, `favorite:`, `pool:`, `type:`, `sort:` (NekoBooru-only) | ignored | ignored | ignored | ignored | ignored |
| other `key:value` | pass if key in DANBOORU_META | pass if key in DANBOORU_META | pass if key in SANKAKU_META | pass if key in GELBOORU_META | pass if key in GELBOORU_META |

```js
const DANBOORU_META = ['id','user','score','favcount','width','height','mpixels','ratio','filesize','filetype','source','parent','child','status','date','age','order','rating','pool','approver','tagcount','duration','md5']
const SANKAKU_META  = ['id','user','score','width','height','source','parent','rating','date','md5','file_type','threshold']
const GELBOORU_META = ['id','user','score','width','height','source','parent','rating','sort','md5','status']
```

**Danbooru term budget:** anonymous Danbooru accepts two terms total. After
translation, keep the first two of: plain tags in typed order, then negations,
then `~` terms, then the rating term, then the order term, then other
metatags. Everything cut is added to `ignored` and `note` becomes
"Danbooru allows 2 search terms without an account; ignored: ...". The section
header shows `ignored` for every site as "ignored here: a, b".

**Sankaku term budget:** anonymous Sankaku accepts four terms (more answer
HTTP 429 code `snackbar__anonymous_tags-limit`); the same priority cut and
note apply with `SANKAKU_TERM_LIMIT = 4`.

### 3.4 Request budget - `frontend/src/remote/budget.js` (budget 60-120)

`createBudget({ burst = 6, perSecond = 1 })` returns `{ take(): boolean, retryInMs(): number, coolDown(seconds), coolingDown(): boolean, reset() }`
- a token bucket plus a cooldown, a JS twin of `_RequestBudget`/`_cooldowns`
in `backend/app/services/booru_suggest.py`. One instance per site lives in the
results composable. A search or Load more that cannot `take()` is **deferred**
(the section shows "waiting N s for Danbooru's request budget") and retried
when `retryInMs()` elapses, never dropped. A 429 (or the relay's 429) cools the
site down for `Retry-After` seconds when the response exposes it, else 60 s,
capped at 900 s; a 503 from a browser-direct site does the same. The typing
debounce (500 ms, section 3.6) sits in front of the bucket.

### 3.5 Adapter interface - `frontend/src/remote/adapters/<site>.js` (budget 150-300 each)

Each adapter file exports a frozen object:

```js
export const danbooruAdapter = {
  id: 'danbooru',                 // SITES id
  label: 'Danbooru',
  transport: 'browser',           // 'browser' | 'relay'
  pageSize: 40,                   // posts per request (sankaku 40, e621 40, gelbooru 42, safebooru 42)

  /** Pure: translateQuery(this.id, query, options) - exposed so the UI can show `ignored` before results arrive. */
  translate(query, options) {},

  /**
   * @param {{ query: string, options: QueryOptions, cursor: Cursor|null, signal: AbortSignal, api: typeof api }} args
   * @returns {Promise<{ posts: RemotePost[], nextCursor: Cursor|null, total: number|null, ignoredTerms: string[], note: string|null }>}
   * Throws RemoteSearchError { site, status, message, retryAfterMs|null, kind: 'throttled'|'upstream'|'network'|'query'|'credentials'|'disabled' }.
   */
  async search(args) {},

  /**
   * A fresh copy of one post right before import (Sankaku's signed URLs expire; others may just return `post`).
   * Must return a RemotePost with a non-null fileUrl or throw RemoteSearchError kind 'unavailable'.
   */
  async refresh(post, { signal, api }) {},
}
```

Cursor shapes: danbooru/e621 `{ page: 2 }` (1-based; first request `null`),
gelbooru/safebooru `{ page: 2 }` (the relay turns it into `pid`), sankaku
`{ next: '<hex>' }`. `nextCursor` is `null` when the page came back shorter
than `pageSize`, when `meta.next` is missing (Sankaku), or when the site's
paging cap is reached (danbooru 1000, e621 750).

Browser-direct adapters fetch with
`fetch(url, { signal, headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' })`;
no custom headers beyond `Accept` (keeps requests simple-CORS; Sankaku's
preflight allows more but is unnecessary). Relay adapters call `api.searchGelbooru(params, signal)`
/ `api.searchSafebooru(params, signal)` (section 3.9). All adapters map HTTP
errors: 429/503 -> `throttled` (read `Retry-After` when exposed; the relay's
JSON detail carries `retryAfter` too), 422 with a Danbooru error body ->
`query` with the upstream `message`, 403 with detail code
`booru_search_disabled` -> `disabled`, 400 `gelbooru_credentials_missing` ->
`credentials`, other >= 400 -> `upstream`, `TypeError` from fetch ->
`network`. Adapters never catch `AbortError`.

Per-site request construction (the adapter is the only place that knows it):

| Site | Request |
|---|---|
| danbooru | `GET https://danbooru.donmai.us/posts.json?tags=<t>&page=<n>&limit=40` ; `refresh`: `GET /posts/<id>.json` |
| e621 | `GET https://e621.net/posts.json?tags=<t>&page=<n>&limit=40&_client=NekoBooru/1.0` ; `refresh`: `GET /posts/<id>.json?_client=NekoBooru/1.0` -> `{post}` |
| sankaku | `GET https://sankakuapi.com/posts/keyset?tags=<t>&limit=40[&next=<cursor>]` ; `refresh`: `GET https://sankakuapi.com/posts/<id>` |
| gelbooru | `api.searchGelbooru({ tags, page, limit: 42 })` ; `refresh`: returns `post` unchanged (Gelbooru URLs are stable) |
| safebooru | `api.searchSafebooru({ tags, page, limit: 42 })` ; `refresh`: returns `post` unchanged |

`frontend/src/remote/adapters/index.js` (budget 30-60) exports
`ADAPTERS = { danbooru: danbooruAdapter, ... }` and `adapterFor(site)`.

Each adapter has a vitest file beside it (`danbooru.test.js`, ...) that feeds a
trimmed **real** response saved under `frontend/src/remote/fixtures/<site>.json`
(one or two posts, the fields from section 1, personal data removed) through
`search()` with a stubbed `fetch`/`api`, and asserts: key/id/URLs/dims,
category mapping for every category the site has, rating -> safety for each
rating value, the unavailable cases (Danbooru banned row, e621 null URLs,
Sankaku missing `file_url`), `nextCursor` presence/absence, the exact request
URL (params and `_client`), and error mapping for 429 and 422.

### 3.6 Results composable - `frontend/src/remote/useRemoteResults.js` (budget 350-550)

```js
export function useRemoteResults({ adapters = ADAPTERS, api, lookupInLibrary = createInLibraryLookup(api) } = {})
// returns
{
  sections,          // reactive { [site]: { posts: RemotePost[], cursor, loading, error: RemoteSearchError|null, total, totalIsEstimate, page, totalPages, limit, ignoredTerms, note, exhausted, waitingMs, fetched, ratingFiltered } }
                     // total: Gelbooru/Safebooru from the relay (exact), Danbooru from adapter.count() once per search (exact),
                     // e621 (tags.json post_count) and Sankaku (tag row post_count) estimates for a single plain tag only
  order,             // computed: ticked remote sites in SOURCE_IDS order
  interleaved,       // computed: round-robin merge of every ticked section's posts (first of each, second of each, ...), minus posts whose key is in `inLibrary` when NekoBooru is ticked
  inLibrary,         // reactive Map<key, { postId }>
  anyLoading,        // computed
  search({ query, options, sites, hiddenKeys }),   // debounced 500 ms from the caller's watch; aborts in-flight requests; resets sections; fires every ticked remote site concurrently
                                                   // hiddenKeys: Set<string> of remote keys the library page already holds (from its <site>_<id> tags); hidden in `interleaved` even before the lookup answers
  loadMore(site),                      // next page for one section (grouped mode)
  loadMoreAll(),                       // next page for every ticked section (interleaved mode)
  postByKey(key),                      // RemotePost | null
  markImported(key, postId),           // sets inLibrary and emits nothing else
  retry(site),                         // re-run the last request for a failed section
  dispose(),                           // abort everything (onUnmounted)
}
```

Behaviour:
- `search()` is called by the home view after a 500 ms debounce on the
  `[query, options, sites]` tuple; a query identical to the previous one
  re-runs only for newly ticked sites (sections for unticked sites are
  removed, their requests aborted).
- Each section owns one `AbortController`; a new `search()` or an unticked
  site aborts it. Responses for aborted requests are discarded.
- Client-side safety filter (3.3) and per-section dedupe by `key` on every
  page. Safety-filtered posts do not count as "results"; when a page yields
  zero visible posts but `nextCursor` exists, the composable does **not**
  auto-fetch the next page (budget); the header shows "40 fetched, 0 match the
  rating filter" and Load more stays available.
- `waitingMs` is set while the budget defers a request (section 3.4) and
  while a `throttled` cooldown runs; the section header shows it.
- After every page, the new keys are handed to `lookupInLibrary` (3.6.1).

#### 3.6.1 In-library lookup - `frontend/src/remote/inLibrary.js` (budget 80-140)

`createInLibraryLookup(api)` returns `{ lookup(keys): Promise<void>, found: reactive Map, mark(key, postId) }`.
`lookup` coalesces calls for 150 ms, skips keys already asked, posts chunks of
at most 200 keys to `api.lookupInLibrary(keys)`, and writes results into
`found`. A failed call is retried once after 2 s, then dropped (badges are a
courtesy). The import queue calls `lookup([key])` for one key right before
downloading, awaiting the result (`lookupNow(key) -> {postId}|null`, a second
method that bypasses coalescing).

### 3.7 Import queue - `frontend/src/remote/useImportQueue.js` (budget 400-600)

```js
export function useImportQueue({ api, adapters = ADAPTERS, inLibrary, onImported })
// returns
{
  items,         // reactive [{ key, post, status, message, postId: number|null, duplicate: boolean, attempt }]
                 // status: 'queued'|'checking'|'resolving'|'downloading'|'saving'|'merging'|'done'|'skipped'|'failed'|'retrying'|'cancelled'
  running,       // ref boolean
  progress,      // computed { done, total, failed, skipped }
  options,       // reactive { autoTag: false, extraTags: [], safetyOverride: '', poolId: null|number|'__new__', newPoolName: '' }
  enqueue(posts: RemotePost[]),   // dedupes by key; ignores posts with unavailable fileUrl (marks them failed "no original file")
  start(),       // runs until the queue is empty; no-op when running
  cancel(),      // finishes the current item, marks the rest cancelled
  clearFinished(),
}
```

Pipeline per item, strictly one item at a time (same order as the extension's
`importAll`):

1. **checking** - `inLibrary.lookupNow(key)`. Found -> **merging**: `GET /api/posts/{id}`
   (`api.getPost`), then `PUT /api/posts/{id}` with the union of tags (existing
   first, then the item's `tagsForImport`), `stricterSafety(existing, item)`,
   `source: existing.source || post.postUrl`, `tagCategories`, `tagDisplayNames`
   - identical to `mergeDuplicate` in `browser-extension/site-import.js`. ->
   `skipped` with message "Already in NekoBooru · tags merged · #id",
   `onImported(key, id, updatedPost)`. No download gap after a skip.
2. **resolving** - `adapters[site].refresh(post)` (fresh Sankaku URL; others
   return the post). Then the two batched lookups, done **once per `start()`**
   before the first item and cached in a Map for the run:
   - Gelbooru categories: `api.gelbooruTagCategories(allTagsOfQueuedGelbooruPosts)`
     (chunks of 500) -> fills `tagCategories` of Gelbooru items; on failure
     keep `general` and continue.
   - Danbooru spelling: for queued **Sankaku and e621** items, collect their
     character/copyright tags and call `api.danbooruNames({ tags, tagCategories })`
     once (max 500 tags; chunk if more) -> `renames`. Apply like
     `useDanbooruNames`: replace in `tags`, move the category, record
     `renames` for step 5. Failure -> no renames.
   `tagsForImport = [...renamedTags, ...options.extraTags (normalised)]` plus
   `idTagFor(post)` appended if missing with category `meta`.
3. **downloading** - `api.fetchFromUrl({ url: fileUrl, referer: post.referer, progressId })`
   with `progressId = crypto.randomUUID()`; poll `api.getFromUrlProgress(progressId)`
   every 1 s and set `message` with the extension's `downloadProgressText`
   format ("Downloading original… 12.3 / 36.0 MB (34%) · 180 KB/s · 70s").
   The queue waits **1.5 s** before a download whenever the previous item
   downloaded (not after a skip). Error message matching `/HTTP (429|503)\b/`
   -> **retrying** with waits 10 s, 30 s, 60 s (`attempt` 1..3), then `failed`.
   A 409 "already downloading" -> wait 5 s once, then fail.
4. **saving** - `api.createPost(body)` with

   ```js
   {
     contentToken: upload.token,
     safety: options.safetyOverride || post.safety,
     tags: tagsForImport,
     tagCategories: { ...post.tagCategories (renamed), ...extraTagCategories(none), [idTag]: 'meta' },
     tagDisplayNames: post.tagDisplayNames,
     source: post.postUrl,
     autoTag: options.autoTag === true,
     autoTagProfile: 'booru_search',   // label stored on saved AI analyses; any string is accepted
   }
   ```
   This is `siteImportPostBody(job, item, token)` from
   `browser-extension/site-import-core.js` with `autoTag` driven by the card
   switch. Success -> `done`, `postId = data.id`, `onImported(key, id, data)`.
   409 with `detail.code === 'duplicate_post'` -> **merging** as in step 1
   (restore first via `POST /api/posts/{id}/restore` when `detail.deleted`),
   `duplicate = true`, `done`.
5. **aliases** (after each item, best effort) - for each `renames[from] = to`
   of this item: `api.createAlias({ alias: from, target: to, sankakuName: site === 'sankaku' ? from : undefined })`;
   409/400 ignored.
6. **pool** (once, after the queue drains) - when `options.poolId` is set:
   `'__new__'` -> `api.createPool({ name })`, then `api.addPostsToPool(poolId, importedIds)`
   with every `done`/`skipped` id.

Errors never stop the queue; a failed item keeps its message. `cancel()`
after the current item. `onImported(key, postId, postDict)` is how the home
view swaps selection (section 4.4).

### 3.8 Source store - `frontend/src/stores/remoteSources.js` (budget 100-160)

Pinia store `useRemoteSourcesStore`:

```js
{
  sources: ref(['nekobooru']),           // ticked SOURCE_IDS, in SOURCE_IDS order; never empty (last one cannot be unticked)
  layout: ref('grouped'),                // 'grouped' | 'interleaved'
  libraryTicked: computed,
  remoteSites: computed,                 // sources without 'nekobooru'
  toggle(sourceId), setSources(list), setLayout(mode),
  fromRoute(query),                      // reads ?sources=a,b and ?layout=interleaved; invalid ids dropped
  toRouteQuery(),                        // { sources: 'nekobooru,danbooru' | undefined (when only nekobooru), layout: 'interleaved' | undefined }
}
```

Persistence: `localStorage` keys `nekobooru.remoteSources` (JSON array) and
`nekobooru.remoteLayout`; URL wins over storage on load; every change writes
storage and `router.replace({ query: { ...route.query, ...toRouteQuery() } })`
(replace, not push, so Back does not step through ticks). All `localStorage`
access in try/catch like `loadBatchDock()` in HomeView.

### 3.9 API client additions - `frontend/src/api/client.js`

Add to the `api` object (the `request()` helper is reused; a `signal` option
is passed through `fetch` via `options.signal`, which `request()` already
spreads):

```js
// Booru search (section 2)
async getBooruSearchStatus() { return request('/booru-search/status') },
async searchGelbooru(params, signal) { return request(`/booru-search/gelbooru?${new URLSearchParams(params)}`, { signal }) },
async searchSafebooru(params, signal) { return request(`/booru-search/safebooru?${new URLSearchParams(params)}`, { signal }) },
async lookupInLibrary(keys) { return request('/booru-search/in-library', { method: 'POST', body: JSON.stringify({ keys }) }) },
async gelbooruTagCategories(tags) { return request('/booru-search/gelbooru-categories', { method: 'POST', body: JSON.stringify({ tags }) }) },
async danbooruNames(tags, tagCategories) { return request('/site-imports/danbooru-names', { method: 'POST', body: JSON.stringify({ tags, tagCategories }) }) },
async fetchFromUrl({ url, referer, progressId }) { return request('/uploads/from-url', { method: 'POST', body: JSON.stringify({ url, referer, progressId }) }) },
async getFromUrlProgress(progressId) { return request(`/uploads/from-url/progress/${encodeURIComponent(progressId)}`) },
async restorePost(id) { return request(`/posts/${id}/restore`, { method: 'POST' }) },
// Admin switch (section 2.2)
async getBooruSearchSettings() { return request('/settings/booru-search') },
async updateBooruSearchSettings(enabled) { return request('/settings/booru-search', { method: 'PUT', body: JSON.stringify({ enabled }) }) },
```

`stores/auth.js` gains `const canBrowseBoorus = computed(() => user.value?.canBrowseBoorus === true)`
and exports it (owned by P3b; P5 only calls the existing `fetchMe()`).

### 3.10 Components - `frontend/src/components/remote/`

| File | Budget | Responsibility |
|---|---|---|
| `SourcePicker.vue` | 150-250 | The button + checkbox dropdown (sources in `SOURCE_IDS` order, NekoBooru first), the grouped/interleaved toggle at its foot, Gelbooru greyed with "needs an API key in Settings" when `status.gelbooruConfigured` is false. Props: none (uses `useRemoteSourcesStore`, `api.getBooruSearchStatus()` once). Closes on outside click/Escape. Rendered only when `authStore.canBrowseBoorus`. |
| `RemotePostCard.vue` | 150-250 | One remote post: `<img :src="post.thumbUrl" referrerpolicy="no-referrer" loading="lazy">` with placeholder (site badge + `#id`) on error or null thumb; site badge; video/gif badge; "in library" badge linking to `/post/<id>` (`router-link`, `@click.stop`); unavailable overlay; selection check; same hold/shift/pointer contract as `PostCard.vue` (550 ms hold -> `hold-select`, click in select mode -> `toggle {key, shiftKey}`, otherwise `open`). Props: `post`, `selectMode`, `selected`, `inLibraryPostId`. Emits `toggle`, `hold-select`, `hover-post`, `open` - payloads carry the string `key`. |
| `RemoteSection.vue` | 150-250 | One source's section in grouped mode: header (site label, count/total, `ignoredTerms`/`note`, error with Retry, waiting countdown), a `RemotePostCard` grid using the same column rules as `PostGrid.vue`'s CSS, "Load more" footer. Props: `site`, `section`, `selectMode`, `selectedKeys`, `inLibrary`. Emits `load-more`, `retry`, plus the card events. |
| `RemoteViewer.vue` | 250-400 | Fullscreen overlay (Teleport to body, like the batch-optimize preview in HomeView) reusing `MediaViewer.vue` for the media (`src = post.fileUrl || post.sampleUrl`, `type` from `mediaType`; MediaViewer's `<img>`/`<video>` need `referrerpolicy="no-referrer"` - add a `noReferrer` boolean prop to `MediaViewer.vue` that sets the attribute, default false) and a side panel: site badge, `#id`, rating pill, `width × height`, file size, tags grouped by category (character, copyright, artist, general, meta) using `tagDisplayNames`, source link, booru link (`postUrl`, `rel="noopener noreferrer"`), **Import** button (emits `import`), "in library → open" when imported, prev/next within the section (emits `navigate(delta)`), Escape closes. Props: `post`, `inLibraryPostId`, `hasPrev`, `hasNext`. |
| `ImportCard.vue` | 250-400 | The batch panel card (section 4.4): count of selected remote posts, the options form (`autoTag` switch default off, extra tags via `TagInput.vue`, safety override select, pool select loaded with `api.getPools({limit:100})` + "Create new pool"), Start/Cancel, the item list with status/message per item (the extension's progress window, inline). Props: `queue` (the `useImportQueue` return), `selectedRemote: RemotePost[]`. |
| `../BooruSearchAdminCard.vue` | 80-150 | Settings card: checkbox "Enable booru search", help text ("lets every logged-in user search Danbooru, e621, Sankaku, Gelbooru and Safebooru from the home page and import posts"), saves with `api.updateBooruSearchSettings`, then `authStore.fetchMe()`. Rendered in `SettingsView.vue` under `v-if="authStore.isAdmin"`. |

### 3.11 New-file inventory and line budgets

| Path | Budget | Package |
|---|---|---|
| `backend/app/services/booru_access.py` | 40-80 | P1a |
| `backend/app/services/booru_search.py` | 250-400 | P1b |
| `backend/app/routers/booru_search.py` | 150-250 | P1b |
| `tests/test_booru_access.py` | 100-200 | P1a |
| `tests/test_booru_search.py` | 200-400 | P1b |
| `frontend/src/remote/types.js` (+ `types.test.js`) | 120-200 (+100) | P2a |
| `frontend/src/remote/queryTranslation.js` (+ test) | 250-400 (+250) | P2a |
| `frontend/src/remote/budget.js` (+ test) | 60-120 (+80) | P2a |
| `frontend/src/remote/adapters/danbooru.js` (+ test, fixture) | 150-300 | P2b |
| `frontend/src/remote/adapters/e621.js` (+ test, fixture) | 150-300 | P2c |
| `frontend/src/remote/adapters/sankaku.js` (+ test, fixture) | 150-300 | P2d |
| `frontend/src/remote/adapters/gelbooru.js` (+ test, fixture) | 150-250 | P2e |
| `frontend/src/remote/adapters/safebooru.js` (+ test, fixture) | 120-220 | P2f |
| `frontend/src/remote/adapters/index.js` | 30-60 | P3a |
| `frontend/src/remote/useRemoteResults.js` (+ test) | 350-550 (+250) | P3a |
| `frontend/src/remote/inLibrary.js` (+ test) | 80-140 (+80) | P3a |
| `frontend/src/stores/remoteSources.js` (+ test) | 100-160 (+80) | P3a |
| `frontend/src/remote/useImportQueue.js` (+ test) | 400-600 (+300) | P4a |
| `frontend/src/components/remote/SourcePicker.vue` (+ test) | 150-250 | P3b |
| `frontend/src/components/remote/RemotePostCard.vue` (+ test) | 150-250 | P3b |
| `frontend/src/components/remote/RemoteSection.vue` | 150-250 | P3b |
| `frontend/src/components/remote/RemoteViewer.vue` | 250-400 | P3b |
| `frontend/src/components/remote/ImportCard.vue` (+ test) | 250-400 | P4b |
| `frontend/src/components/BooruSearchAdminCard.vue` (+ test) | 80-150 | P5 |

---

## 4. Home view integration (after Stage 0)

Stage 0 is splitting `frontend/src/views/HomeView.vue` (3,432 lines at the
time of writing) into components/composables and redesigning the hold-to-select
batch panel on a separate branch. Its result is not visible here, so this
section states responsibilities and the contract the Stage 3/4 agents must
find or create. **Before touching anything, the P3b and P4b agents read the
post-Stage-0 `frontend/src/views/HomeView.vue` and every file it imports from
`frontend/src/components/` and `frontend/src/composables/` (or wherever Stage 0
put them), and map the names below onto what exists.** Where Stage 0 already
provides a hook (string keys, an Import card slot), use it; where it does not,
add the smallest adapter in the Stage 0 file that owns that concern.

What the current HomeView does that this feature touches (pre-Stage-0 names,
for orientation): `fetchPosts()` builds `query = postsStore.query + -safety:
exclusions` and calls `/api/posts`; `safetyFilter`, `sortBy`, `sortOrder`,
`perPage`, `page` are refs; selection is `selectMode`, `selectedIds` (numbers),
`lastSelectedId`, `hoveredPostId`, with `toggleSelect({id, shiftKey})`,
`enterSelectModeFromHold(id)`, `toggleRange`, `selectAllVisible`,
`clearSelection`, `selectedPostsInCurrentView()`; the batch panel is a
`<section class="batch-panel">` with `<details class="batch-card">` cards and a
`batchOperation` status strip; `PostGrid.vue` renders `PostCard.vue` per post
keyed by `post.id` and emits `toggle`, `hold-select`, `hover-post`.

### 4.1 Source dropdown placement (P3b)

`SourcePicker.vue` is mounted in `frontend/src/App.vue` immediately after
`<SearchBar />` inside `.header-right`, with
`v-if="route.name === 'home' && authStore.canBrowseBoorus"`. This is the only
App.vue change. (Rationale: the search bar lives in the app header, not in
HomeView; the decision says "next to the home search bar".) On narrow screens
(`max-width: 768px`) the picker collapses to an icon button; its dropdown uses
the same fixed positioning trick as `.suggestions` in `SearchBar.vue`.

### 4.2 Sections in the grid (P3b)

HomeView (or the Stage 0 grid wrapper) renders, when `canBrowseBoorus` and the
store has any remote site ticked:

- **Grouped**: the library block (toolbar count, `PostGrid`, both
  `Pagination`s) as today, only when `nekobooru` is ticked, wrapped in a
  section header "NekoBooru · N posts"; then one `RemoteSection` per ticked
  remote site in `SOURCE_IDS` order.
- **Interleaved**: one grid of mixed cards: `PostCard` for library posts and
  `RemotePostCard` for `results.interleaved`, the library page first then the
  remote feed round-robin (remote duplicates of library posts hidden via
  `inLibrary` + the library posts' `<site>_<id>` tags - the home view builds
  the set of id tags present on the current library page and passes it to the
  composable as `hiddenKeys` so the hide works before the lookup returns);
  one "Load more" button that calls `loadMoreAll()`; library paging stays at
  the top.
- When no remote site is ticked (default) nothing of this renders and the
  view is byte-for-byte today's behaviour (the acceptance test).

The remote query is `postsStore.query` (without safety exclusions) and
`options = { safety: safetyFilter.value, sort: sortBy.value, order: sortOrder.value }`;
a `watch` on `[query, options, store.remoteSites]` debounced 500 ms calls
`results.search()`. Changing a safety checkbox therefore re-searches remote
sections too (decision 14).

### 4.3 Selection with string keys (P3b)

The selection set holds strings (`'nekobooru:42'`, `'danbooru:123'`). If Stage
0 left numbers for library posts, P3b converts at the boundary in **one**
place (a `selection` composable or the HomeView wrapper): `PostCard`'s numeric
`toggle`/`hold-select` payloads become `libraryKey(id)`, `RemotePostCard`
payloads are already keys. Derived values the batch panel needs:

```js
selectedLibraryIds   // numbers, from keys with site 'nekobooru' -> every existing tool uses THIS instead of selectedIds
selectedRemotePosts  // RemotePost[] via results.postByKey, in selection order
counts               // { total, library, remote } for the header "N selected · X library · Y remote"
```

Shift-range selection stays within one section (range over the clicked
section's visible list; cross-section shift-click acts as a plain toggle).
"Select page" selects the library page plus every loaded remote post of the
visible sections. The hovered-post inspector shows a `RemotePost` too (thumb,
site, tags) when the hovered key is remote.

Existing tools (`AI Tag Selected`, `Tags & Rating`, `Media Optimizer`,
`Organize & Cleanup`, header `Delete`) are fed `selectedLibraryIds` and show
"acts on X library posts"; they are disabled when X is 0. Delete never sees a
remote key.

### 4.4 Import card and selection swap (P4b)

`ImportCard.vue` is added as a `batch-card` (open by default when
`counts.remote > 0`, hidden when 0). It receives `selectedRemotePosts` and the
`useImportQueue` instance created in the home view with
`onImported(key, postId, postDict)` doing:

1. replace `key` with `libraryKey(postId)` in the selection (same position),
2. `results.markImported(key, postId)` (badge appears, interleaved duplicate
   hides),
3. add `postDict` to an `importedPosts` reactive Map on the home view so that
   `selectedPostsInCurrentView()`-style helpers resolve library posts from
   `posts ∪ importedPosts` (the imported post is not on the current library
   page); if the library section is ticked and sorted newest-first, also
   prepend `postDict` to the library page list so the user sees it.

The card's "Import N remote posts" button enqueues `selectedRemotePosts`
(skipping ones already `inLibrary`, which are swapped immediately via the same
`onImported` path with their existing id) and starts the queue. The panel's
status strip reuses `batchOperation` with the queue's progress.

### 4.5 Remote viewer (P3b)

Clicking a `RemotePostCard` outside select mode emits `open(key)`; the home
view sets `viewerKey` and renders `RemoteViewer` (Teleport) with
`post = results.postByKey(viewerKey)`, prev/next within that post's section
(`sections[site].posts`), `import` -> enqueue that single post and start the
queue (the batch panel need not be open; a toast reports the result via the
existing `showMessage`).

### 4.6 What the Stage 3/4 agents must adapt in the post-Stage-0 structure

Checklist (each item names the concern; the file is whatever Stage 0 created):

1. Where the library query/sort/safety state lives -> feed `results.search()`.
2. Where the grid is rendered -> add the grouped sections / interleaved grid
   (4.2) without changing library-only rendering when nothing remote is ticked.
3. Selection state and its key type -> string keys (4.3); every batch tool
   switches from the raw selection to `selectedLibraryIds`.
4. Batch panel header -> "N selected · X library · Y remote".
5. Batch panel card list -> add `ImportCard` (4.4); hover inspector -> accept a
   `RemotePost`.
6. Fullscreen overlays (the batch-optimize preview uses `Teleport` +
   `MediaViewer`) -> add `RemoteViewer` the same way.
7. `onUnmounted` -> `results.dispose()` and `queue.cancel()`.
8. Any Stage 0 vitest that asserts selection payload shapes -> update to keys.

If Stage 0 shipped the home view as several files each under 800 lines, P3b
and P4b keep every file under 800 by putting new logic in the new files of
section 3 and only wiring in the Stage 0 files.

#### 4.6.1 What Stage 0 actually shipped (merged at `c128641`)

- `frontend/src/views/HomeView.vue` (382 lines) - page toolbar, grid,
  pagination; wires the composables and slots the cards into the panel.
- `frontend/src/composables/usePostBrowser.js` - search, safety filter, sort,
  pagination, route sync (item 1 above).
- `frontend/src/composables/useSelection.js` - `useSelection(items, { keyOf })`:
  select mode, toggle, shift-range, hold, select page, clear, hover. It makes
  no numeric assumptions; `useSelection.test.js` already covers keys like
  `"danbooru:7"` (item 3).
- `frontend/src/composables/useBatchDock.js`, `useBatchOperations.js`,
  `useBatchAiTagging.js`, `useBatchPostEdits.js`, `useBatchMediaOptimize.js`,
  `usePostSemanticAnalysis.js` - the batch tools (item 3: they must act on
  `selectedLibraryIds`).
- `frontend/src/components/batch/BatchPanel.vue` - dock/resize shell, header
  toolbar (item 4), status, and a card grid fed through a default slot: a new
  card is added in `HomeView.vue` inside `<BatchPanel>` wrapped in
  `BatchCard.vue` (item 5).
- `frontend/src/components/batch/PostInspectorCard.vue` - hovered post details
  (item 5: accept a `RemotePost`).
- `frontend/src/components/batch/MediaOptimizeDialogs.vue` - the Teleport +
  `MediaViewer` overlays (item 6).
- `frontend/src/views/HomeView.test.js` - mount test for Select, Select page,
  dock, Done and header Delete (item 8).

---

## 5. Work packages

Every file is owned by exactly one package. "Starts" is the earliest start;
"Merges after" is the fast-forward order onto `main`. Package agents commit
only their files, run their tests, rebase onto `main`, re-run, and
`git merge --ff-only` (per CLAUDE.md rule 2). **No package commits
`frontend/dist/`**; only P6 rebuilds it.

### 5.1 Package table

| Pkg | Name | Files owned | Depends on | Runs concurrently with | Starts |
|---|---|---|---|---|---|
| P1a | Permission gate + admin setting | `backend/app/services/booru_access.py`, `backend/app/services/settings.py` (add get/set), `backend/app/routers/settings.py` (2 routes), `backend/app/routers/auth.py` (`canBrowseBoorus`), `tests/test_booru_access.py` | - | P1b, P2a-f, P4a, P5 | now |
| P1b | Relays, in-library lookup, Gelbooru categories, e621 UA | `backend/app/services/booru_search.py`, `backend/app/routers/booru_search.py`, `backend/app/main.py` (one `include_router`), `backend/app/routers/uploads.py` (e621 UA), `tests/test_booru_search.py` (also holds the e621 UA unit test) | P1a (imports `require_booru_search`; code against 2.1 now, rebase before tests) | P1a, P2a-f, P4a, P5 | now |
| P2a | Remote groundwork | `frontend/src/remote/types.js`, `queryTranslation.js`, `budget.js`, their tests, `frontend/src/api/client.js` (3.9 additions) | - | P1a, P1b, P2b-f (they code against 3.1-3.5 verbatim) | now |
| P2b | Danbooru adapter | `frontend/src/remote/adapters/danbooru.js`, `danbooru.test.js`, `frontend/src/remote/fixtures/danbooru.json` | P2a (merge order only) | all of P1/P2 | now |
| P2c | e621 adapter | `adapters/e621.js`, test, `fixtures/e621.json` | P2a | all of P1/P2 | now |
| P2d | Sankaku adapter | `adapters/sankaku.js`, test, `fixtures/sankaku.json` | P2a | all of P1/P2 | now |
| P2e | Gelbooru adapter | `adapters/gelbooru.js`, test, `fixtures/gelbooru.json` (fixture is a raw dapi row set written from section 1.5 fields; no live key needed) | P2a, contract 2.4 | all of P1/P2 | now |
| P2f | Safebooru adapter | `adapters/safebooru.js`, test, `fixtures/safebooru.json` | P2a, contract 2.4 | all of P1/P2 | now |
| P4a | Import queue (logic only) | `frontend/src/remote/useImportQueue.js`, `useImportQueue.test.js` | P2a contracts (3.1, 3.5, 3.9) - injected `api`/`adapters`, so no merged code needed to start | everything except P4b | now |
| P5 | Admin Settings card | `frontend/src/components/BooruSearchAdminCard.vue`, its test, `frontend/src/views/SettingsView.vue` (import + `v-if="authStore.isAdmin"` block) | P1a contract 2.2, P2a client methods (merge order) | P1, P2, P3a, P4a | now |
| P3a | Results composable, registry, store | `frontend/src/remote/adapters/index.js`, `useRemoteResults.js` (+test), `inLibrary.js` (+test), `frontend/src/stores/remoteSources.js` (+test) | P2a-f merged | P3b's component work, P4a, P5 | after all P2 merged |
| P3b | Search UI + home view wiring | `frontend/src/components/remote/SourcePicker.vue`, `RemotePostCard.vue`, `RemoteSection.vue`, `RemoteViewer.vue`, their tests, `frontend/src/App.vue`, `frontend/src/stores/auth.js`, `frontend/src/components/MediaViewer.vue` (`noReferrer` prop), the post-Stage-0 home view files for 4.1-4.3 and 4.5 | Stage 0 merged, P3a merged (components can be built before; wiring after) | P4a, P5 | components: after Stage 0; wiring: after P3a |
| P4b | Import card + selection swap | `frontend/src/components/remote/ImportCard.vue` (+test), the post-Stage-0 batch panel files for 4.4 | P3b merged, P4a merged | P5 | after P3b |
| P6 | Integration | `README.md`, `frontend/dist/**`, final test run, browser check | everything | - | last |

Serialisation rule: P3b and P4b are the only packages that edit home-view
files, and they run one after the other. `SettingsView.vue` is edited only by
P5; `App.vue`, `stores/auth.js`, `MediaViewer.vue` only by P3b;
`api/client.js` only by P2a; `main.py`, `uploads.py` only by P1b;
`settings.py` (router and service) and `auth.py` only by P1a.

### 5.2 Integration order onto main (fast-forward only)

1. P1a -> 2. P1b -> 3. P2a -> 4. P2b, P2c, P2d, P2e, P2f (any order) -> 5. P4a ->
6. P5 -> 7. (Stage 0 must be on main by now) P3a -> 8. P3b -> 9. P4b -> 10. P6.

Each merge: rebase the package branch on `main`, run `cd tests && ../venv/Scripts/python.exe -m unittest discover -s . -p "test_*.py"`
(Windows) and `cd frontend && npm run test`, then `git merge --ff-only`. The
known baseline failure `test_extension_upload_defaults_can_be_saved` is not
attributable to this work.

### 5.3 Package specifications

#### P1a - Permission gate + admin setting

Implements 2.1, 2.2, 2.3 exactly. Tests (`tests/test_booru_access.py`,
`TestClient` harness copied from `tests/test_user_auth.py` with
`reset_engine_for_tests()` and a bootstrap admin plus a second non-admin user
created via `POST /api/auth/users` and logged in with a second `TestClient`):

- default: `GET /api/settings/booru-search` as admin -> `{"enabled": false}`;
  `GET /api/auth/me` -> `canBrowseBoorus: false` for both users.
- `PUT /api/settings/booru-search {"enabled": true}` as non-admin -> 403; as
  anonymous -> 401; as admin -> 200 `{"enabled": true}`, persisted in
  `settings.json` under `booruSearch.enabled`, and `me` now reports
  `canBrowseBoorus: true` for both users.
- unit: `booru_search_allowed(user)` returns the flag; `require_booru_search`
  raises `HTTPException(403)` with detail code `booru_search_disabled` when off.

Acceptance: the four tests pass; `grep -rn "get_booru_search_settings" backend/app`
shows exactly one reader (`booru_access.py`) plus the two settings routes.

#### P1b - Relays, lookup, categories, e621 UA

Implements 2.4, 2.5-as-consumed, 2.6. Service functions (all `async`, all
take `timeout: float = DEFAULT_TIMEOUT`):

```python
async def gelbooru_search_page(tags: str, page: int, limit: int) -> dict      # {"site","page","limit","total","posts"}
async def safebooru_search_page(tags: str, page: int, limit: int) -> dict
async def in_library_lookup(db, keys: list[str], owner_ids: list[int]) -> dict  # {"found": {...}}
async def gelbooru_categories(tags: list[str]) -> dict                           # {"categories": {...}}
def parse_key(key: str) -> tuple[str, str] | None                               # ("danbooru", "123") or None
class UpstreamThrottled(RuntimeError): retry_after: float | None
class UpstreamError(RuntimeError): status: int | None
```

The router maps `PermissionError` -> 400 `gelbooru_credentials_missing`,
`UpstreamThrottled` -> 429 `upstream_throttled` (+ `Retry-After` header),
`UpstreamError`/`RuntimeError` -> 502 `upstream_error`, `ValueError` -> 400.

Tests (`tests/test_booru_search.py`, same harness; patch
`app.services.booru_search._fetch_json` with `AsyncMock` as
`tests/test_site_imports.py` does; flip the switch through the admin PUT or by
patching `booru_access.booru_search_allowed`):

- gate: with the switch off, each of `GET /gelbooru`, `GET /safebooru`,
  `POST /in-library`, `POST /gelbooru-categories` returns 403 with detail code
  `booru_search_disabled`; `GET /status` returns 200 `enabled: false`.
- gelbooru relay: `page=3&limit=42&tags=" cat_ears   rating:general "` ->
  upstream params `pid=2, limit=42, tags="cat_ears rating:general"`, includes
  `user_id`/`api_key`; response echoes raw rows and `total` from
  `@attributes.count`; single-object `post` becomes a one-element list; no
  credentials -> 400 `gelbooru_credentials_missing`; upstream 429 -> 429 with
  `Retry-After`; upstream 500 -> 502.
- safebooru relay: bare array passthrough, `total` from the cached XML count (null on failure), non-array -> `[]`.
- in-library: seed two users' posts with tags `danbooru_1` (user A),
  `sankaku_abc` (user A, soft-deleted), `e621_5` (user B); as A the lookup for
  `['danbooru:1','sankaku:abc','e621:5','bogus','danbooru:zzz']` returns only
  `danbooru:1`; after B shares with A (`PUT /api/auth/shares`), `e621:5`
  appears; 501 keys -> 400; empty -> 400.
- gelbooru-categories: delegates to `site_imports._tag_categories` (patched)
  and returns `{"categories": {...}}`.
- e621 UA unit test (2.6) in `test_booru_search.py` (the function is pure;
  `tests/test_url_upload.py` is not touched).

Acceptance: tests pass; `POST /api/site-imports/gelbooru-search` test suite
(`tests/test_site_imports.py`) still passes unchanged; the extension code is
untouched.

#### P2a - Remote groundwork

Implements 3.1, 3.3, 3.4, 3.9 verbatim. Tests: `types.test.js`
(key helpers incl. Sankaku alphanumeric ids, `booruDisplayNames` parity with
the extension's regex, `stricterSafety`), `queryTranslation.test.js` (every
row of the three tables in 3.3 for every site, the Danbooru two-term budget
cases: 0/1/2/3 plain tags with and without rating/order, `safety:` folding,
`md5:`/`hash:` mapping, unknown metatag ignored and listed), `budget.test.js`
(burst, refill with a fake clock, cooldown from `Retry-After`, cap 900 s).

Acceptance: `npm run test` green; `client.js` additions compile; no UI.

#### P2b-P2f - Adapters

Each implements 3.5 for its site using only `types.js`, `queryTranslation.js`
and the injected `api`/`fetch`. Fixture: save a real response (P2e uses the
dapi field list from 1.5 to hand-write one; nothing in the fixture may contain
credentials). Tests as listed in 3.5. Danbooru additionally tests the
`media_asset.variants` 360x360 thumb selection and the ugoira `zip` ->
`large_file_url` rule; e621 tests `_client` on both search and refresh and the
`sources[0]` mapping; Sankaku tests `created_at.s` -> ISO, `tagName` fallback
to `name_en`, type 2/5/8/9 mapping, `meta.next` cursor and `refresh()` URL;
Gelbooru/Safebooru test the relay params `{tags, page, limit}` and the
`total`/`exhausted` logic.

Acceptance: each adapter's test green in isolation; file under its budget.

#### P4a - Import queue

Implements 3.7 with `api` and `adapters` injected (so its test uses fakes and
needs no merged adapter). Tests with `vi.useFakeTimers()`: order and one-at-a-
time; skip-with-merge when in library (PUT body equals the extension's
`mergeDuplicate` body); 1.5 s gap only after downloads; 10/30/60 s backoff on
"HTTP 429"/"HTTP 503" then failure; `409 duplicate_post` -> restore (when
`deleted`) + merge; Danbooru renames applied and aliases posted with
`sankakuName` only for Sankaku; Gelbooru categories fetched once per run;
`createPost` body equality with the 3.7 literal including `idTag` and
`autoTag` from options; pool added once at the end; `cancel()` semantics;
`onImported` arguments.

Acceptance: tests green; the file never imports Vue components.

#### P5 - Admin Settings card

Implements `BooruSearchAdminCard.vue` and mounts it in `SettingsView.vue`
(inside the existing settings layout, near the extension/AI defaults cards)
under `v-if="authStore.isAdmin"`. Test (vitest + `@vue/test-utils`, `api`
mocked): renders the current value from `getBooruSearchSettings`; toggling
calls `updateBooruSearchSettings(true)` then `authStore.fetchMe`; a 403 from
the API shows the error text and reverts the checkbox.

Acceptance: non-admins never see the card (test mounts with `isAdmin: false`
and asserts absence).

#### P3a - Results composable, registry, store

Implements 3.6, 3.6.1, 3.8 and `adapters/index.js`. Tests with fake adapters
and fake timers: debounce; concurrent fan-out; abort of superseded searches
(`AbortSignal` passed through, late responses discarded); per-site dedupe and
client safety filter; round-robin `interleaved` and hiding of `inLibrary`
keys when NekoBooru is ticked; `loadMore`/`loadMoreAll` cursor handling and
`exhausted`; budget deferral (`waitingMs`) and cooldown on `throttled`; the
in-library coalescing (one request for keys arriving within 150 ms, chunks of
200, retry once); store persistence/URL round-trip (`fromRoute`/`toRouteQuery`,
last source cannot be unticked).

Acceptance: tests green; no component imports.

#### P3b - Search UI + home wiring

Implements 3.10 (all but ImportCard), 4.1-4.3, 4.5, 4.6 items 1-4, 6-8, and
the `canBrowseBoorus` computed in `stores/auth.js`. Tests: `SourcePicker.test.js`
(renders nothing when `canBrowseBoorus` is false - **the gate test** - renders
the six sources when true, ticks persist to the store, Gelbooru disabled when
`gelbooruConfigured` is false); `RemotePostCard.test.js` (`referrerpolicy`
attribute present on the img, placeholder on error, `toggle` payload is the
key, hold emits `hold-select` with the key after 550 ms, in-library badge
links to `/post/<id>`); a home-view-level test (adapted to the Stage 0
structure) that with only `nekobooru` ticked renders no `RemoteSection` and
the same `PostGrid` as before.

Acceptance: with the switch off the home view DOM is unchanged from `main`
before this package (compare snapshots of `.home-view` in a vitest mount);
with it on and Danbooru ticked, a manual browser check shows a Danbooru section
with thumbnails loading (no referer), Load more paging, hold-to-select across
sections, and the viewer.

#### P4b - Import card + selection swap

Implements `ImportCard.vue` and 4.4 using the merged `useImportQueue`. Test:
mounts the card with a fake queue, asserts the option defaults (`autoTag`
false), that Start enqueues only remote selections, and that `onImported`
wiring swaps `'danbooru:1'` for `'nekobooru:42'` in the selection (home-view
level test adapted to Stage 0).

Acceptance: manual check - select two remote posts, Import; items progress
"checking → downloading (progress text) → saving → done"; the cards show "in
library"; the selection now holds two library posts and "Tags & Rating" can be
applied to them; a second Import of the same posts is skipped with "tags
merged".

#### P6 - Integration

- `README.md`: a "Booru search" subsection under Features/Search describing
  the admin switch, the sources, transport (what the browser contacts
  directly vs. the server), the Gelbooru key requirement, imports, and the
  rate-limit behaviour.
- `cd frontend && npm run build`; commit `frontend/dist/` as "Rebuild frontend
  assets".
- Full backend and frontend test runs on `main`; browser check of the
  acceptance items of P3b and P4b with the switch off and on.

---

## 6. Risks and resolved gaps

| # | Gap found | Resolution |
|---|---|---|
| 1 | Draft said "extend `POST /api/site-imports/gelbooru-search`"; that route needs `ids`, resolves categories (slow) and is used verbatim by the extension. | New gated router `/api/booru-search` (2.4); the old route is untouched, so the extension keeps working and the switch cannot break it. |
| 2 | Danbooru's anonymous two-term limit counts `rating:`/`order:` (verified 422). A translated query with tags + rating + sort would fail every time. | Term budget with fixed priority and a header note (3.3); safety is always re-applied client-side. |
| 3 | A 401 from a new route (e.g. "no Gelbooru key") would log the user out (`client.js` redirects on 401). | New routes never answer 401 except for missing login; credentials problems are 400 `gelbooru_credentials_missing` (status table at the top of section 2). |
| 4 | Sankaku's signed file URLs expire within hours; a long import queue would download dead links. | `adapter.refresh(post)` right before each download (3.5, 3.7). |
| 5 | `e926.net` vs `e621.net` share ids; two id tags would break the in-library lookup. | Always `e621_<id>`; the source is labelled "e621 / e926" (1.3). |
| 6 | Browser cannot send a User-Agent; e621 wants client identification. | `_client=NekoBooru/1.0` on every browser request; honest UA server-side for `*.e621.net`/`*.e926.net` downloads (2.6). |
| 7 | Safebooru categories: the draft hoped for a lookup; the dapi tag endpoint ignores `names` and answers XML (verified). | Safebooru imports stay general-only; open question 1 offers a Danbooru-backed resolver as a follow-up. |
| 8 | How the "in library" lookup scopes to shared libraries. | `visible_owner_ids` on both `Tag.owner_id` and `Post.owner_id`, soft-deleted excluded (2.4). |
| 9 | Selection keys for library posts after Stage 0 are unknown. | Fixed remote format `<site>:<id>`, library `nekobooru:<id>` by default, with a one-place conversion rule (3.1, 4.3). |
| 10 | Imported posts are not on the current library page, so batch tools cannot find their post objects. | `importedPosts` map merged into the selected-posts helper (4.4). |
| 11 | Remote `<img>` referer: `MediaViewer.vue` has no way to set `referrerpolicy`. | `noReferrer` prop added by P3b (3.10). |
| 12 | Which agent owns shared files (`client.js`, `App.vue`, `main.py`, README, `dist`). | Single-owner table in 5.1; `dist` only in P6. |
| 13 | Adapters need a registry but each adapter is its own package. | `adapters/index.js` belongs to P3a, which starts after all adapters merge (5.1). |
| 14 | `autoTagProfile` semantics for imports. | It is only a label stored on saved AI analyses (`posts.py` line ~288); use `'booru_search'`. |
| 15 | Relay returning normalised vs raw rows. | Raw rows; one normalisation code path (frontend adapters), relay stays trivial and testable. |
| 16 | Soft-deleted local copies: skip or re-import? | Lookup treats them as absent; the `409 duplicate_post` path restores and merges, matching the extension (2.4, 3.7). |
| 17 | Per-user access later. | Single `booru_search_allowed(user)` + `require_booru_search` dependency; UI reads only `canBrowseBoorus` (2.1, 2.3). |
| 18 | Request amplification from typing and Load more. | 500 ms debounce, per-site token bucket, cooldown from `Retry-After`, deferral instead of drop (3.4, 3.6). |
| 19 | Sankaku `~`/sort support unverified. | Treated as ignored with a header note; safe default (3.3). |
| 20 | Gelbooru category resolution at search time would cost one tag request per page. | Categories only at import, batched once per queue run via `_tag_categories` (2.4, 3.7). |

Residual risks: booru API changes (fixture-based tests only catch regressions
in our parsing, not upstream drift); Sankaku may hide more posts from
anonymous callers over time (shown as unavailable, never as errors); Cloudflare
may challenge browser-direct requests from some networks (surfaced as
`upstream` errors in the section header with Retry).

## 7. Owner answers (all defaults accepted)

The owner accepted every default below. Item 1 is additionally scheduled as
**P7 - Safebooru categories via Danbooru**, a follow-up package after P6:
resolve Safebooru tag categories through Danbooru's `/tags.json` as described
in item 1, used at import time only (like Gelbooru's), with tests. Item 5:
"pool" is NekoBooru's existing Pools feature (ordered post collections); the
Import card's optional pool field is chosen per import run.

**Page size (owner decision, overrides the flat default 40 in item 2):**
each remote source uses its booru's own default page size - Danbooru 20,
e621 75, Sankaku 20, Gelbooru 42, Safebooru 42 (verified live) - recorded as
`defaultLimit`/`maxLimit` in the `types.js` site registry with an
`effectiveLimit(site, requested)` helper. The home per-page dropdown
(`PER_PAGE_OPTIONS` in `composables/usePostBrowser.js`) gains a "Default"
option, selected out of the box: each source then uses its own default
(NekoBooru keeps 42). Picking a number applies it to every ticked source,
capped at each site's max (P3a/P3b). The relays' `limit` defaults to 42.

### Original questions and defaults

1. **Safebooru tag categories** - default: general-only, as the draft said.
   Alternative worth a follow-up package: resolve categories through
   Danbooru's `/tags.json?search[name_comma]=..&only=name,category` (Safebooru
   mirrors Danbooru's tag vocabulary; `site_imports._danbooru_get` already
   exists), batched 80 names per request and cached a day.
2. **Default remote page size** - default 40 (Gelbooru/Safebooru 42 to match
   their site pages). Larger pages mean more thumbnails per request budget
   token but a heavier first paint.
3. **Danbooru term budget behaviour** - default: send the first two terms and
   list the rest as ignored (results are a superset). Alternative: skip
   Danbooru entirely and show only the note.
4. **Interleaved order** - default: library page first, then remote
   round-robin. Alternative: true round-robin including the library.
5. **Import pool option** - default: pool chosen per queue run in the Import
   card (as decision 9 lists it). If the owner prefers, the pool could be the
   current query's `pool:` filter when present.

## Constraints

- Every file at most 800 lines; new modules aim for 200-800 lines, grouped by
  functionality (small composables are fine when genuinely self-contained).
- Follow CLAUDE.md: no absolute paths, AI deps stay optional, match style,
  no new dependencies, `frontend/dist/` rebuilt and committed separately.
- Multi-agent work: each agent in its own worktree; integrate with
  `git merge --ff-only` after rebasing and re-running tests; frontend work
  touching shared files is serialized.
- No package may store, log or echo booru credentials; the Gelbooru key stays
  in `settings.json` and travels only inside the server's httpx `params`.
