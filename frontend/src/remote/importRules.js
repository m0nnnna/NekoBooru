// The booru import rules, owned by browser-extension/booru-import-rules.js
// for both the extension and this app (post body, duplicate merge, display
// names, progress text, pacing and back-off). That file is a plain script
// the extension loads with <script>, so it is imported for its side effect
// and read off globalThis. Vite serves it from outside src through
// server.fs.allow in vite.config.js.
import '../../../browser-extension/booru-import-rules.js'

const rules = globalThis.NekoBooruImportRules

export const {
  DOWNLOAD_GAP_MS,
  RETRY_DELAYS_MS,
  MAX_THROTTLE_WAIT_MS,
  SAFETY_ORDER,
  stricterSafety,
  booruDisplayNames,
  downloadProgressText,
  importPostBody,
  isDuplicatePost,
  duplicateTarget,
  mergePostBody,
  throttleDelayMs,
  slowDownText,
} = rules
