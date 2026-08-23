// Shared auth helper for every extension page (popups, options) and the
// background service worker. Plain script (not a module) so it works via
// <script src> in HTML pages AND importScripts() in background.js.
//
// NekoBooru instances now require a logged-in account for essentially every
// API call. A browser extension page is a different origin from the
// instance, so it never has the instance's session cookie - instead, the
// user generates a long-lived API token in the web UI (Settings > Account &
// Sharing) and pastes it in here once. authFetch() attaches it as a bearer
// token; callers that used to do a plain fetch(url, opts) should do
// NekoAuth.authFetch(url, opts) instead - same signature, same Response.
(function (root) {
  async function getApiToken() {
    const stored = await chrome.storage.sync.get(['apiToken'])
    return stored.apiToken || null
  }

  async function authFetch(url, options = {}) {
    const token = await getApiToken()
    if (!token) return fetch(url, options)
    const headers = new Headers(options.headers || {})
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    return fetch(url, { ...options, headers })
  }

  root.NekoAuth = { authFetch, getApiToken }
})(typeof self !== 'undefined' ? self : this)
