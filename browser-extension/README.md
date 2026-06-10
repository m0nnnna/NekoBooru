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
to open SauceNAO, TinyURL, IQDB, TinEye, Google Lens, trace.moe, or all of them
at once. Google Lens uses a temporary extension helper page that submits the
image/frame bytes directly instead of relying on a public image URL. The menu
also includes **Download current frame PNG** for video/GIF/image frame searches
where a site needs an uploaded file instead of a URL.

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
API. The helper starts the backend on `127.0.0.1:8772` and the frontend on
`127.0.0.1:5173`.

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
| `background.js` | Registers the context menus and opens the popups. |
| `upload.html` / `upload.js` / `upload.css` | The upload popup UI + logic (CSS shared with the picker). |
| `picker.html` / `picker.js` | The "insert from NekoBooru" browse/search popup. |
| `options.html` / `options.js` | Settings page (instance URL). |
| `native-host/` | Optional native messaging helper for starting the local app. |
| `icons/` | Toolbar / store icons. |
