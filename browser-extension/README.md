# Download to NekoBooru — Browser Extension

Right-click any image or video on the web and send it straight to your
NekoBooru instance, picking tags and a rating first. Works in Chrome, Edge,
Brave, and other Chromium browsers (and Firefox, see notes below).

## How it works

The extension adds three right-click menu items:

### Download to NekoBooru (web → your instance)

1. You right-click an image/video and choose **Download to NekoBooru**.
2. A small popup opens with a preview, a tag box (with live autocomplete from
   your instance, where confirmed tags become pills), and a rating selector.
3. On upload the extension asks your instance to fetch the media
   (`POST /api/uploads/from-url`) and then creates the post
   (`POST /api/posts`). If the server can't fetch the URL directly (hotlink
   protection, login-gated images, etc.) it falls back to downloading the bytes
   in your browser and uploading them.

#### Downloading from trace.moe

trace.moe has no per-result page, so after a search a **NekoBooru** button
appears beside the result player's **Share** button. It sends the matched scene
clip (`api.trace.moe/video/…`, at the largest `size=l`) with the show's AniList
page as the source. Right-clicking the player also offers **Download to
NekoBooru**, since the site's overlay keeps the click off the `<video>` itself.

The button also records where the clip came from: the player's release filename,
the season and episode parsed out of it (`S01E01`, `1x01`, `Season 1 Episode 1`,
or fansub `Title - 05`), and the scene's start/end in the episode (from the
clip's `x-video-start` / `x-video-end` headers). These are saved as the post's
**Semantic Description** (model `trace.moe`), so `s01e01`, `episode_1` or the
release name find it in search. The right-click route has no player info, so
it saves the clip only.

The series is tagged as a **copyright** tag spelled the way Danbooru files it.
The popup takes the show's titles from trace.moe's info pane (heading and
**Alias** row) plus the filename's title, and looks each up in Danbooru's
tags API. Aliases resolve, so the English title still finds a romaji-named
tag. If Danbooru has no tag for the show yet, the show's own title is used
instead, and the popup says so.

#### Downloading from another booru

When the media came from a booru post page, the popup imports that post's own
tags — already split into artist / character / copyright / meta — along with its
rating, and those categories are sent with the post so they survive the import.
Supported: Danbooru (`*.donmai.us`), Gelbooru, Safebooru, rule34.xxx and other
Gelbooru clones, yande.re / Konachan, e621 / e926, and Sankaku (classic
`chan.sankakucomplex.com` and `sankaku.app`).

Tags are read from the open tab's sidebar first, which costs no request and is
the only route that works on Gelbooru — its JSON API returns 401 without an API
key. The site's JSON API is the fallback for when that tab is gone. Sankaku is
the exception: its API is asked first, because its sidebar uses tag types
(studio, genre, medium) the page reader does not know. Everything
is additive: nothing you already typed is removed, and on any other site the
import stays silent.

### Insert media from NekoBooru (your instance → wherever you're posting)

1. While composing a post anywhere (e.g. X), right-click and choose **Insert
   media from NekoBooru…**.
2. A popup opens that browses your instance — search by tags (with
   autocomplete), filter by rating and type (`GET /api/posts`).
3. Click a result to pull it out: **images are copied to your clipboard** so you
   can paste them straight into the composer; **GIFs and videos download**
   instead (the clipboard can't hold them) so you can attach the file.

### NekoBooru reverse image search

Right-click an image, GIF, or video and choose **NekoBooru reverse image search**
to open SauceNAO, IQDB, TinEye, Google Lens, trace.moe, or all of them at once.
On a NekoBooru post page, the **Search** tab lists the same providers and each
opens one tab. The page reads the image (or the current video frame) itself and
hands the bytes to the extension, since media URLs need the instance's login.
Without the extension, SauceNAO and IQDB still work as plain form uploads;
Google Lens, TinEye, and trace.moe need it. Google now refuses a plain post to
Lens's upload endpoint (403), so the extension opens google.com and gives the
file to Lens's own upload box instead. **Exact lookup** uses the app directly
and does not require the extension.

On a Pixiv artwork page, the NekoBooru download icon appears immediately to the
right of Pixiv's Share button using the same native control styling. It imports
selected pages using Pixiv's `original` image URLs; the popup starts with every
page checked and waits for **Import selected**. Each post keeps the Pixiv artwork
link, shared `pixiv_<id>` tag, page-specific `pixiv_<id>_p<n>` tag, artist reference, and
the readable artist name in the artist category, plus Pixiv tags. On Gelbooru
post pages, **NekoBooru** appears as a native-style text link directly to the
right of the Favorite/Unfavorite action. On Safebooru it appears on the right
side of the post action row, after **Edit | Respond**. It imports
the site's original `file_url` plus its tag categories, with AI tagging
disabled. Safebooru's API has no categories, so tags its page leaves general
are looked up on Danbooru, whose vocabulary it mirrors (80 names a request,
cached a day; a failed lookup just leaves them general). On Danbooru post pages, **NekoBooru** sits right of **Comments |
Recommended** under the post, as one more item of that menu (pages without it
get **Import to NekoBooru** in the sidebar's **Options** list). It reads the
post's own `/posts/<id>.json` from the page, so no API key is needed and your
Danbooru login comes along, which means Gold-only originals work
if your account has them. It imports the full-resolution `file_url` (videos
included; ugoira, which Danbooru stores as a zip of frames, comes as Danbooru's
webm) with Danbooru's artist / copyright / character / general / meta
categories, its rating, and a `danbooru_<id>` tag. Tags with punctuation that
NekoBooru flattens (`seitokai_ni_mo_ana_wa_aru!`) keep their spelling as the
display name. On a Danbooru search page, **NekoBooru** sits right of
**Posts | Artist** and imports every post the page shows (blacklisted ones
excepted) the same way. One `/posts.json?tags=id:…` request fetches the whole
page, files download one at a time with a pause between them, a 429/503 backs
off and retries, and posts an earlier import already brought in (found by
their `danbooru_<id>` tag) are not downloaded again - their tags are merged
instead. Gelbooru search pages get the same: a **NekoBooru** bar right above
the thumbnails imports every post shown. Gelbooru's API needs the key saved in
NekoBooru Settings, so the backend resolves the page - one API call replaying
the page's search, plus tag-type lookups shared by the whole page and cached
for a day - and the downloads are paced, retried and de-duplicated (by
`gelbooru_<id>`) the same way. On classic Sankaku Channel post pages, a cat icon in the
neighbouring icons' colour sits right of the flag under the post, and
**Import to NekoBooru** appears in the sidebar's Actions list, right under
**Find similar**. On `sankaku.app` the cat sits immediately left of the heart
(favourite count) in the post sidebar. Where none of these is found, a floating
**NekoBooru** button sits in the bottom-right corner instead. All of them follow
the site's in-app navigation. It imports the original `file_url`
with Sankaku's tag types (studios file as artist, medium as meta) and a
`sankaku_<id>` tag. If you are logged in to Sankaku in that browser, the import
reuses the page's own session token, sent only to Sankaku's API, so explicit
and members-only posts work. When Sankaku's API still refuses a post (it hides
some from anonymous API requests even while you can see them), the import reads
the page instead: the Details box's **Original** link, the sidebar's tags
grouped by heading, and the rating badge. Sankaku spells qualified
characters and series in full (`honoka_(dead_or_alive)`) where Danbooru,
Gelbooru, and Safebooru abbreviate (`honoka_(doa)`), so imports look each one up
on Danbooru, take its spelling, and keep the Sankaku one as a NekoBooru tag
alias (which also merges a tag already imported under it). If Danbooru cannot be
reached, the Sankaku names are kept. Logged out, Sankaku withholds those
originals and the button says so. Pixiv imports explicitly run and save AI tags, including when
an original already exists; Gelbooru, Safebooru, Danbooru, and Sankaku imports never invoke AI.
Most services use temporary extension helper pages that submit the image/frame
bytes directly instead of relying on a public image URL. TinEye and trace.moe
open their official UIs and inject the captured image into their upload controls. The menu also includes
**Download current frame PNG** for video/GIF/image frame searches where a site
needs an uploaded file instead of a URL.

No login/token is required — it talks to the same open API the web UI uses, so
point it at an instance only you can reach (localhost or your LAN/VPN).

## Install (Chrome / Edge / Brave)

If you grabbed a packaged zip from the GitHub releases page, unzip it first and
use the extracted `nekobooru-extension` folder in step 3 below. (To build that
zip yourself, run `build-extension.bat` / `build-extension.sh` from the repo
root — see `README-BUILD.md`.)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `browser-extension` folder.
4. Click the extension's icon in the toolbar (or open its **Options**) and set
   your **instance URL**, e.g. `http://localhost:8772`. Use **Test connection**
   to confirm it can reach the server, then **Save**.

That's it — right-click an image anywhere and pick **Download to NekoBooru** or
**NekoBooru reverse image search**.

### Optional: Start NekoBooru from the extension

Chromium extensions cannot launch local programs directly. To let the upload
popup start the local backend and frontend when they are down, install the
native launcher helper once:

1. Open `brave://extensions` or `chrome://extensions`.
2. Copy this extension's ID.
3. Run PowerShell from the repo root:

   ```powershell
   .\browser-extension\native-host\install-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID
   ```

4. Reload the extension.

After that, the upload popup shows **Start NekoBooru** when it cannot reach the
API. The helper starts the backend on `127.0.0.1:8772`, which serves the built
UI from `frontend/dist` on the same port. To also run the Vite dev server on
`127.0.0.1:5173` (live reload while working on the frontend), add
`"frontendDev": true` to
`%LOCALAPPDATA%\NekoBooru\native-messaging-hosts\launcher-config.json`.

## Install (Firefox)

Firefox supports Manifest V3. To try it:

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select `manifest.json` in this folder.
3. Open the add-on's preferences and set the instance URL.

Temporary add-ons are removed when Firefox restarts. For a permanent install
the extension needs to be signed/packaged.

## Settings

- **Instance URL** — the base URL of your NekoBooru server (where you open the
  gallery). Saved with `chrome.storage.sync`.
- The last rating you used is remembered for the next upload.

## Permissions

- `contextMenus` — adds the right-click menu items.
- `storage` — remembers your instance URL and last rating.
- `notifications` — shows a success/failure toast after uploading.
- `clipboardWrite` — copies an image to your clipboard when you insert media
  from your instance.
- `downloads` — saves a GIF/video to your download shelf (so it keeps going
  after the picker auto-closes) when you insert one.
- `nativeMessaging` — optional; lets the extension ask the local launcher
  helper to start NekoBooru when the API is down.
- `cookies` — lets the upload popup pass your local X/Twitter cookies to the
  local backend for one yt-dlp request, so locked/protected posts you can view
  in Brave can be downloaded. The cookies are not saved by the extension.
- `host_permissions: *://*/*` — needed so the popup can talk to your instance
  (whatever URL you set) and, as a fallback, download media bytes from the page
  you're on.

## Limitations

- Videos that play from a `blob:` URL or an adaptive stream (HLS/DASH) usually
  can't be uploaded — there's no single downloadable file behind them.
- The instance must be reachable from your browser and (for the preferred
  server-side fetch) from the server.
- Locked/protected X posts require the same Brave profile to be logged into an
  account that can view the post.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (MV3). |
| `background.js` | Registers the context menus and opens the popups; the service worker entry. |
| `background-x-media.js` / `background-site-import.js` / `background-reverse-search.js` | The worker's X media cache, booru tag lookups and site-import windows, and reverse image search (pulled in by `background.js` via `importScripts`). |
| `upload.html` / `upload.js` / `upload.css` | The upload popup UI + logic (CSS shared with the picker). `upload.js` is the entry and loads last. |
| `upload-ai-models.js` | Upload popup AI model lists: profile defaults, model-key array, id→flag map, runtime requirements. |
| `upload-ai-controls.js` / `upload-ai-preview.js` | Upload popup AI tagging: model picker, profiles, loads, and the suggestion preview. |
| `upload-preview.js` / `upload-tags.js` / `upload-media-fetch.js` | Upload popup media preview, tag box, and getting media (cookies, X capture, content token) to the server. |
| `picker.html` / `picker.js` | The "insert from NekoBooru" browse/search popup. |
| `options.html` / `options.js` | Settings page (instance URL). |
| `trace-moe-buttons.js` | trace.moe content script: the result player's NekoBooru button. |
| `trace-moe-core.js` | trace.moe helpers: filename parsing, scene description, Danbooru series lookup. |
| `danbooru-categories.js` | Danbooru tag-category lookup for Safebooru imports (loaded by `site-import.html`). |
| `saucenao-links.js` | SauceNAO content script: rewrites dead old-format Sankaku links (`/post/show/<id>`) to `/posts/similar?id=<id>`. |
| `native-host/` | Optional native messaging helper for starting the local app. |
| `icons/` | Toolbar / store icons. |
