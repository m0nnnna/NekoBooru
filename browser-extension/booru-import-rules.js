// The booru import rules, owned here once for both clients: the extension's
// import page (site-import.js) and the web app's import queue
// (frontend/src/remote/useImportQueue.js, through importRules.js). The post
// body, the duplicate merge, tag display names, download progress text, and
// the pacing and back-off of a batch all come from this file.
//
// A plain script: loaded before site-import-shared.js wherever that runs
// (manifest content scripts, background.js importScripts, site-import.html),
// by require() under Node tests, and by a side-effect import in the web app.
// No DOM, chrome.* or fetch. Cases both clients run:
// booru-import-rules.fixture.json.
;(function installBooruImportRules(root) {
  // A batch imports one post at a time, pausing between downloads so a big
  // page cannot trip the site's limits; a 429/503 backs off and retries.
  const DOWNLOAD_GAP_MS = 1500
  const RETRY_DELAYS_MS = [10000, 30000, 60000]
  // A server-suggested wait (Retry-After) is honoured up to this long.
  const MAX_THROTTLE_WAIT_MS = 900000
  const SAFETY_ORDER = ['safe', 'sketchy', 'unsafe']

  // The stricter of two ratings, unknown values counting as 'safe'.
  function stricterSafety(first, second) {
    return SAFETY_ORDER[Math.max(SAFETY_ORDER.indexOf(first), SAFETY_ORDER.indexOf(second), 0)]
  }

  // NekoBooru flattens tag names to letters, digits and _ : . - only, so a
  // Danbooru tag like "seitokai_ni_mo_ana_wa_aru!" keeps its spelling only as
  // the display name - which is also what the tag menu's booru searches use.
  // All-symbol tags ("?", "@_@") flatten to nothing and get none.
  function booruDisplayName(raw) {
    const tag = String(raw ?? '').trim()
    return /[^\p{L}\p{N}_:.-]/u.test(tag) && /[\p{L}\p{N}]/u.test(tag) ? tag.replace(/_/g, ' ') : ''
  }

  // { key: display name } for the tags that need one. The extension keys by
  // the tag as given (the backend flattens the keys); the web app passes its
  // flattening as `keyOf`. The first tag to claim a key wins.
  function booruDisplayNames(tags, keyOf = (tag) => tag) {
    const names = {}
    for (const raw of tags || []) {
      const display = booruDisplayName(raw)
      const key = display && keyOf(String(raw ?? '').trim())
      if (key && !(key in names)) names[key] = display
    }
    return names
  }

  // "Downloading original… 12.3 / 36.0 MB (34%) · 180 KB/s · 70s". The rate
  // shows a slow source (Sankaku throttles video) for what it is.
  function downloadProgressText(progress, elapsedMs) {
    const received = Math.max(0, Number(progress?.received) || 0)
    const total = Math.max(0, Number(progress?.total) || 0)
    const seconds = Math.max(0, Math.round((Number(elapsedMs) || 0) / 1000))
    const megabytes = (bytes) => (bytes / 1048576).toFixed(1)
    const parts = [total
      ? `${megabytes(received)} / ${megabytes(total)} MB (${Math.min(100, Math.floor((received * 100) / total))}%)`
      : `${megabytes(received)} MB`]
    if (seconds > 0 && received > 0) parts.push(`${Math.round(received / 1024 / seconds)} KB/s`)
    parts.push(`${seconds}s`)
    return `Downloading original… ${parts.join(' · ')}`
  }

  // The POST /api/posts body for an imported original. Each client decides
  // its own source fallback and whether AI tagging runs, under which profile.
  function importPostBody({ contentToken, safety, tags, tagCategories, tagDisplayNames, source, autoTag, autoTagProfile }) {
    return {
      contentToken,
      safety: safety || 'safe',
      tags: tags || [],
      tagCategories: tagCategories || {},
      tagDisplayNames: tagDisplayNames || {},
      source,
      autoTag: autoTag === true,
      autoTagProfile,
    }
  }

  function isDuplicatePost(status, detail) {
    return status === 409 && detail?.code === 'duplicate_post'
  }

  // The library copy a 409 duplicate_post (or an id-tag lookup) points at.
  // `deleted`: restore it before merging.
  function duplicateTarget(detail) {
    const post = detail?.post || {}
    const postId = Number(detail?.postId || post.id)
    if (!postId) throw new Error('The original already exists, but NekoBooru did not return its post ID.')
    return { postId, post, deleted: Boolean(detail?.deleted || post.deletedAt) }
  }

  // The PUT /api/posts/<id> body merging an import into the library copy:
  // the library's tags first, then the import's, the stricter rating, and the
  // library's source unless it has none.
  function mergePostBody(existing, incoming) {
    return {
      tags: [...new Set([...(existing?.tags || []), ...(incoming?.tags || [])])],
      safety: stricterSafety(existing?.safety, incoming?.safety),
      source: existing?.source || incoming?.source || null,
      tagCategories: incoming?.tagCategories || {},
      tagDisplayNames: incoming?.tagDisplayNames || {},
    }
  }

  // A site (or its CDN, via the backend) asking to slow down. The backend's
  // from-url error carries the upstream status in its text; the web app's
  // errors may also say so in `status` (a relay's own 429) or `kind`.
  function isThrottled(error) {
    return /HTTP (429|503)\b/.test(error?.message || String(error || ''))
      || error?.kind === 'throttled' || error?.status === 429 || error?.status === 503
  }

  // How long to wait before retry `attempt` (0-based), or null when the error
  // is not throttling or the back-off is spent. A `retryAfterMs` hint
  // (Retry-After) lengthens the scheduled wait, never shortens it.
  function throttleDelayMs(error, attempt) {
    const scheduled = RETRY_DELAYS_MS[attempt]
    if (scheduled === undefined || !isThrottled(error)) return null
    const hinted = Number.isFinite(Number(error?.retryAfterMs)) ? Math.max(0, Number(error.retryAfterMs)) : 0
    return Math.max(scheduled, Math.min(hinted, MAX_THROTTLE_WAIT_MS))
  }

  function slowDownText(siteLabel, delayMs) {
    return `${siteLabel} asked to slow down · retrying in ${Math.round(delayMs / 1000)} s…`
  }

  const api = {
    DOWNLOAD_GAP_MS,
    RETRY_DELAYS_MS,
    MAX_THROTTLE_WAIT_MS,
    SAFETY_ORDER,
    stricterSafety,
    booruDisplayName,
    booruDisplayNames,
    downloadProgressText,
    importPostBody,
    isDuplicatePost,
    duplicateTarget,
    mergePostBody,
    isThrottled,
    throttleDelayMs,
    slowDownText,
  }
  root.NekoBooruImportRules = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(globalThis)
