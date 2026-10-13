import { normalizeTagName } from '../utils/booruSearchTag.js'
import { booruDisplayNames as sharedDisplayNames, stricterSafety as sharedStricterSafety } from './importRules.js'

// The boorus the home search can aggregate, in display order. `transport`
// says who talks to the booru: the browser directly (the API sends CORS
// headers) or the backend relay under /api/booru-search (no CORS, or a key
// that must stay on the server). `referer` is what imports send to
// /api/uploads/from-url so the server-side download looks like a page visit.
// `defaultLimit` is the booru's own page size (what its site shows), used
// unless the user picks a number in the home per-page dropdown; `maxLimit` is
// the most one API request may ask for (verified live 2026-10-13).
export const SITES = [
  { id: 'danbooru', label: 'Danbooru', transport: 'browser', homepage: 'https://danbooru.donmai.us', referer: 'https://danbooru.donmai.us/', defaultLimit: 20, maxLimit: 200, imageReferrerPolicy: 'strict-origin-when-cross-origin' },
  { id: 'e621', label: 'e621 / e926', transport: 'browser', homepage: 'https://e621.net', referer: 'https://e621.net/', defaultLimit: 75, maxLimit: 320, imageReferrerPolicy: 'strict-origin-when-cross-origin' },
  { id: 'sankaku', label: 'Sankaku', transport: 'browser', homepage: 'https://sankaku.app', referer: 'https://sankaku.app/', defaultLimit: 20, maxLimit: 100 },
  { id: 'gelbooru', label: 'Gelbooru', transport: 'relay', homepage: 'https://gelbooru.com', referer: 'https://gelbooru.com/', defaultLimit: 42, maxLimit: 100 },
  { id: 'safebooru', label: 'Safebooru', transport: 'relay', homepage: 'https://safebooru.org', referer: 'https://safebooru.org/', defaultLimit: 42, maxLimit: 100 },
]
export const LIBRARY_SOURCE = 'nekobooru'
export const SOURCE_IDS = [LIBRARY_SOURCE, ...SITES.map((s) => s.id)] // display order
export const SAFETY_ORDER = ['safe', 'sketchy', 'unsafe']
export const CATEGORIES = new Set(['general', 'artist', 'copyright', 'character', 'meta'])

/**
 * The normalized remote post every adapter returns (section 3.2 of
 * docs/booru-search-plan.md). Never carries the raw booru row.
 *
 * @typedef {Object} RemotePost
 * @property {string} key                 makeKey(site, id), e.g. 'danbooru:12370916'
 * @property {string} site                a SITES id
 * @property {string} id                  always a string (Sankaku ids are alphanumeric)
 * @property {string} postUrl             the post's page on the booru
 * @property {string|null} thumbUrl       grid preview; null -> placeholder card
 * @property {string|null} sampleUrl      optional mid-size image for the viewer's first paint
 * @property {string|null} fileUrl        original; null -> unavailable, Import disabled
 * @property {number|null} width          original width
 * @property {number|null} height         original height
 * @property {string} fileExt             lower-case, no dot; '' when unknown
 * @property {'image'|'gif'|'video'|'unknown'} mediaType
 * @property {number|null} fileSize
 * @property {'safe'|'sketchy'|'unsafe'} safety
 * @property {string} rawRating           the site's own rating letter/word, lower-cased
 * @property {string[]} tags              normalizeTagName()-ed, deduped, without the id tag
 * @property {Object<string, string>} tagCategories    every tag -> a CATEGORIES value
 * @property {Object<string, string>} tagDisplayNames  flat tag -> booru spelling, only tags that flattened
 * @property {string|null} source         the booru's own source field
 * @property {string|null} md5
 * @property {number|null} score
 * @property {string|null} createdAt      ISO timestamp
 * @property {null|'hidden'|'deleted'|'banned'|'no-file'} unavailable  why fileUrl is null
 * @property {string} referer             sent to /api/uploads/from-url
 */

/**
 * @typedef {Object} QueryOptions
 * @property {{ safe: boolean, sketchy: boolean, unsafe: boolean }} safety  the gallery's rating checkboxes
 * @property {'date'|'id'|'size'} sort
 * @property {'asc'|'desc'} order
 */

export function siteById(site) {
  return SITES.find((entry) => entry.id === site) || null
}

// The referrerpolicy for a booru's images in the grid and viewer. Sankaku's
// CDN refuses the app's origin as a Referer, so no Referer is the default;
// Danbooru's and e621's CDNs refuse an image request with no Referer at all
// (checked in a browser 2026-10-13), so they get the browser default, which
// sends the origin only.
export function imageReferrerPolicy(site) {
  return siteById(site)?.imageReferrerPolicy || 'no-referrer'
}

// Posts per request for `site`: its defaultLimit when the user left the
// per-page dropdown on default (null/undefined/'default', or anything that is
// not a positive number), else the requested count capped at maxLimit.
export function effectiveLimit(site, requested) {
  const entry = siteById(site)
  if (!entry) throw new Error(`Unknown booru site: ${site}`)
  if (requested === null || requested === undefined || requested === 'default' || requested === '') return entry.defaultLimit
  const count = Math.floor(Number(requested))
  if (!Number.isFinite(count) || count < 1) return entry.defaultLimit
  return Math.min(count, entry.maxLimit)
}

export function makeKey(site, id) { return `${site}:${id}` } // 'danbooru:123'

// '<site>:<id>' -> { site, id }, or null for anything else. The site must be
// one of SOURCE_IDS; the id may contain letters (Sankaku), digits, _ and -.
export function splitKey(key) {
  if (typeof key !== 'string') return null
  const colon = key.indexOf(':')
  if (colon <= 0) return null
  const site = key.slice(0, colon)
  const id = key.slice(colon + 1)
  if (!SOURCE_IDS.includes(site) || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  return { site, id }
}

// A malformed key is neither remote nor library (the spec's one-liner would
// call it remote, since `null?.site !== LIBRARY_SOURCE`).
export function isRemoteKey(key) {
  const parts = splitKey(key)
  return parts !== null && parts.site !== LIBRARY_SOURCE
}

export function libraryKey(postId) { return `${LIBRARY_SOURCE}:${postId}` } // 'nekobooru:42'

export function libraryIdFromKey(key) {
  const parts = splitKey(key)
  if (!parts || parts.site !== LIBRARY_SOURCE || !/^\d+$/.test(parts.id)) return null
  const id = Number(parts.id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

// The '<site>_<id>' tag every booru import carries ('danbooru_123'). Run
// through normalizeTagName like the extension's normalizeTag(`sankaku_${id}`),
// so a Sankaku id comes out lower-cased exactly as the backend stores it.
export function idTagFor(post) { return normalizeTagName(`${post.site}_${post.id}`) }

// The stricter of two ratings, unknown values counting as 'safe'
// (browser-extension/booru-import-rules.js owns the rule).
export function stricterSafety(a, b) {
  return sharedStricterSafety(a, b)
}

// Display names for booru tags whose spelling does not survive flattening
// ('miyu_(blue_archive)' -> 'miyu (blue archive)'), by the rule in
// browser-extension/booru-import-rules.js, keyed by the flattened name (the
// RemotePost shape), which is also what the backend turns the extension's
// raw keys into.
export function booruDisplayNames(rawTags) {
  return sharedDisplayNames(rawTags, normalizeTagName)
}

// The RemotePost.mediaType rule shared by every adapter (section 3.2).
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'zip'])
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif'])

export function mediaTypeFromExt(fileExt) {
  const ext = String(fileExt ?? '').trim().toLowerCase().replace(/^\./, '')
  if (ext === 'gif') return 'gif'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'unknown'
}

export const REMOTE_ERROR_KINDS = ['throttled', 'upstream', 'network', 'query', 'credentials', 'disabled', 'unavailable']

// What adapters throw (section 3.5). `kind` drives the section header:
// throttled -> cooldown, query -> show the booru's message, credentials ->
// point at Settings, disabled -> the admin switch is off.
export class RemoteSearchError extends Error {
  constructor({ site, status = null, message = '', retryAfterMs = null, kind = 'upstream' } = {}) {
    super(message || `${siteById(site)?.label || site || 'Booru'} request failed`)
    this.name = 'RemoteSearchError'
    this.site = site
    this.status = status
    this.retryAfterMs = retryAfterMs
    this.kind = REMOTE_ERROR_KINDS.includes(kind) ? kind : 'upstream'
  }
}
