# Download to NekoBooru — Browser Extension

Right-click any image or video on the web and send it straight to your
NekoBooru instance, picking tags and a rating first. Works in Chrome, Edge,
Brave, and other Chromium browsers (and Firefox, see notes below).

## How it works

1. You right-click an image/video and choose **Download to NekoBooru**.
2. A small popup opens with a preview, a tag box (with live autocomplete from
   your instance), and a rating selector.
3. On upload the extension asks your instance to fetch the media
   (`POST /api/uploads/from-url`) and then creates the post
   (`POST /api/posts`). If the server can't fetch the URL directly (hotlink
   protection, login-gated images, etc.) it falls back to downloading the bytes
   in your browser and uploading them.

No login/token is required — it talks to the same open API the web UI uses, so
point it at an instance only you can reach (localhost or your LAN/VPN).

## Install (Chrome / Edge / Brave)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `browser-extension` folder.
4. Click the extension's icon in the toolbar (or open its **Options**) and set
   your **instance URL**, e.g. `http://localhost:8000`. Use **Test connection**
   to confirm it can reach the server, then **Save**.

That's it — right-click an image anywhere and pick **Download to NekoBooru**.

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

- `contextMenus` — adds the right-click menu item.
- `storage` — remembers your instance URL and last rating.
- `notifications` — shows a success/failure toast after uploading.
- `host_permissions: *://*/*` — needed so the popup can talk to your instance
  (whatever URL you set) and, as a fallback, download media bytes from the page
  you're on.

## Limitations

- Videos that play from a `blob:` URL or an adaptive stream (HLS/DASH) usually
  can't be uploaded — there's no single downloadable file behind them.
- The instance must be reachable from your browser and (for the preferred
  server-side fetch) from the server.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (MV3). |
| `background.js` | Registers the context menu, opens the upload popup. |
| `upload.html` / `upload.js` / `upload.css` | The upload popup UI + logic. |
| `options.html` / `options.js` | Settings page (instance URL). |
| `icons/` | Toolbar / store icons. |
