import { normalizeTagName } from '../../utils/booruSearchTag.js'
import { retryAfterSeconds } from '../budget.js'
import { singlePlainTag, translateQuery } from '../queryTranslation.js'
import { RemoteSearchError, booruDisplayNames, effectiveLimit, makeKey, mediaTypeFromExt, siteById } from '../types.js'

// Sankaku through sankakuapi.com, straight from the browser (the API echoes
// the request origin in Access-Control-Allow-Origin). Section 1.4 and 3.5 of
// docs/booru-search-plan.md. Paging is keyset: meta.next is the cursor.

const SITE = siteById('sankaku')
export const SANKAKU_API = 'https://sankakuapi.com'
const POST_PAGE = 'https://sankaku.app/posts/'
export const HIDDEN_MESSAGE = 'Sankaku shows this original only to logged-in users'
// Anonymous searches with more terms than this answer HTTP 429 with code
// snackbar__anonymous_tags-limit - a query problem, not a rate limit
// (verified 2026-10-13: six terms -> 429, param "4").
export const ANONYMOUS_TAG_LIMIT = 4
const TAG_LIMIT_CODE = 'snackbar__anonymous_tags-limit'

// Same table as SANKAKU_TYPE_TO_CATEGORY in browser-extension/site-import-core.js:
// 0 general, 1 artist, 2 studio, 3 copyright, 4 character, 5 genre, 8 medium,
// 9 meta. Studios read as the artist; anything else is general.
export const TYPE_TO_CATEGORY = { 0: 'general', 1: 'artist', 2: 'artist', 3: 'copyright', 4: 'character', 5: 'general', 8: 'meta', 9: 'meta' }

// Sankaku's own letters (sankakuSafety in site-import-core.js): s is safe here.
export function sankakuSafety(raw) {
  const rating = String(raw ?? '').trim().toLowerCase()
  if (rating === 'e' || rating === 'explicit') return 'unsafe'
  if (rating === 'q' || rating === 'questionable') return 'sketchy'
  return 'safe'
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function positiveInt(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null
}

function httpUrl(value) {
  const url = text(value)
  if (url.startsWith('//')) return `https:${url}`
  return /^https?:\/\//i.test(url) ? url : null
}

// The extension of a URL's path ('.../abc.mp4?e=..' -> 'mp4'), '' when none.
function urlExt(url) {
  const match = /\.([a-z0-9]{2,5})$/i.exec(text(url).split(/[?#]/)[0])
  return match ? match[1].toLowerCase() : ''
}

// created_at is { json_class: 'Time', s: <unix seconds>, n: <nanoseconds> }.
function createdAt(raw) {
  const seconds = Number(raw && typeof raw === 'object' ? raw.s : raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const nanos = Number(raw?.n) || 0
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString()
}

// [{ raw, category }] in the booru's own spelling. `tagName` is the
// underscore form; without it the English name is put in that form.
function tagEntries(row) {
  const rows = Array.isArray(row?.tags) ? row.tags : []
  if (!rows.length) {
    const names = Array.isArray(row?.tag_names) ? row.tag_names : []
    return names.map((name) => ({ raw: text(name), category: 'general' }))
  }
  return rows.map((tag) => ({
    raw: text(tag?.tagName) || text(tag?.name_en ?? tag?.name).toLowerCase().replace(/\s+/g, '_'),
    category: TYPE_TO_CATEGORY[Number(tag?.type)] || 'general',
  }))
}

function collectTags(row) {
  const tags = []
  const tagCategories = {}
  const raws = []
  for (const { raw, category } of tagEntries(row)) {
    const tag = normalizeTagName(raw)
    if (!tag || tag in tagCategories) continue
    tags.push(tag)
    tagCategories[tag] = category
    raws.push(raw)
  }
  return { tags, tagCategories, tagDisplayNames: booruDisplayNames(raws) }
}

/** One sankakuapi.com post row -> RemotePost (section 3.2), or null without a usable id. */
export function normalizeSankakuPost(row) {
  const id = text(row?.id)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
  const fileUrl = httpUrl(row.file_url)
  const fileExt = (text(row.file_ext).toLowerCase().replace(/^\./, '') || urlExt(fileUrl)).slice(0, 8)
  const sampleUrl = httpUrl(row.sample_url)
  const md5 = text(row.md5).toLowerCase()
  const score = Number(row.total_score)
  return {
    key: makeKey(SITE.id, id),
    site: SITE.id,
    id,
    postUrl: `${POST_PAGE}${id}`,
    thumbUrl: httpUrl(row.preview_url),
    // A video's sample_url is the video itself; the viewer's first paint wants an image.
    sampleUrl: sampleUrl && mediaTypeFromExt(urlExt(sampleUrl)) !== 'video' ? sampleUrl : null,
    fileUrl,
    width: positiveInt(row.width),
    height: positiveInt(row.height),
    fileExt,
    mediaType: mediaTypeFromExt(fileExt),
    fileSize: positiveInt(row.file_size),
    safety: sankakuSafety(row.rating),
    rawRating: text(row.rating).toLowerCase(),
    ...collectTags(row),
    source: text(row.source) || null,
    md5: /^[0-9a-f]{32}$/.test(md5) ? md5 : null,
    score: row.total_score === null || row.total_score === undefined || !Number.isFinite(score) ? null : score,
    createdAt: createdAt(row.created_at),
    unavailable: fileUrl ? null : (text(row.status).toLowerCase() === 'deleted' ? 'deleted' : 'hidden'),
    referer: SITE.referer,
  }
}

async function readJson(response) {
  try {
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return null
  }
}

function errorFor(response, body) {
  const status = response.status
  const code = text(body?.code)
  if (code === TAG_LIMIT_CODE) {
    const limit = positiveInt(body?.param) || ANONYMOUS_TAG_LIMIT
    return new RemoteSearchError({ site: SITE.id, status, kind: 'query', message: `Sankaku allows ${limit} search terms without an account` })
  }
  if (status === 429 || status === 503) {
    const seconds = retryAfterSeconds(response)
    return new RemoteSearchError({
      site: SITE.id,
      status,
      kind: 'throttled',
      retryAfterMs: seconds === null ? null : seconds * 1000,
      message: 'Sankaku is rate limiting requests',
    })
  }
  const detail = text(body?.error) || code
  return new RemoteSearchError({ site: SITE.id, status, kind: 'upstream', message: `Sankaku answered HTTP ${status}${detail ? `: ${detail}` : ''}` })
}

async function getJson(fetchImpl, url, signal, extra = {}) {
  let response
  try {
    response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      ...extra,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new RemoteSearchError({ site: SITE.id, kind: 'network', message: `Could not reach Sankaku${error?.message ? `: ${error.message}` : ''}` })
  }
  const body = await readJson(response)
  if (!response.ok) throw errorFor(response, body)
  if (body === null || typeof body !== 'object') {
    throw new RemoteSearchError({ site: SITE.id, status: response.status, kind: 'upstream', message: 'Sankaku sent an unreadable response' })
  }
  return body
}

const defaultFetch = (...args) => globalThis.fetch(...args)

// The post_count Sankaku sends with each tag row, for the row named `tag`
// (lower-cased booru spelling) in any of `rows`; null when none carries it.
export function tagPostCount(rows, tag) {
  for (const row of rows) {
    for (const entry of Array.isArray(row?.tags) ? row.tags : []) {
      const name = text(entry?.tagName).toLowerCase() || text(entry?.name_en ?? entry?.name).toLowerCase().replace(/\s+/g, '_')
      if (name !== tag) continue
      const total = Number(entry?.post_count ?? entry?.count)
      if (Number.isFinite(total) && total >= 0) return Math.floor(total)
    }
  }
  return null
}

function translate(query, options) {
  return translateQuery(SITE.id, query, options)
}

/**
 * `limit` is the home per-page choice (null/'default' -> Sankaku's own 20,
 * capped at 100); `fetch` is injectable for tests. `api` is unused: Sankaku is
 * browser-direct.
 */
async function search({ query = '', options = {}, cursor = null, limit = null, signal, fetch: fetchImpl = defaultFetch } = {}) {
  const translated = translate(query, options)
  const params = new URLSearchParams({ tags: translated.tags, limit: String(effectiveLimit(SITE.id, limit)) })
  const next = text(cursor?.next)
  if (next) params.set('next', next)
  const body = await getJson(fetchImpl, `${SANKAKU_API}/posts/keyset?${params}`, signal)
  const rows = Array.isArray(body.data) ? body.data : []
  const posts = rows.map(normalizeSankakuPost).filter(Boolean)
  const nextKey = text(body.meta?.next)
  // Sankaku reports no search total; for a one-tag query the tag's own
  // post_count is a fair estimate (it ignores the rating filter).
  const tag = singlePlainTag(query)
  const total = tag ? tagPostCount(rows, tag) : null
  return {
    posts,
    nextCursor: nextKey && rows.length ? { next: nextKey } : null,
    total,
    totalIsEstimate: total !== null,
    ignoredTerms: translated.ignored,
    note: translated.note,
  }
}

// Signed URLs expire within hours: fetch the post again right before import.
async function refresh(post, { signal, fetch: fetchImpl = defaultFetch } = {}) {
  const id = text(post?.id)
  const unavailable = (status, message = HIDDEN_MESSAGE) => new RemoteSearchError({ site: SITE.id, status, kind: 'unavailable', message })
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw unavailable(null, 'Not a Sankaku post id')
  let body
  try {
    body = await getJson(fetchImpl, `${SANKAKU_API}/posts/${encodeURIComponent(id)}`, signal, { cache: 'no-store' })
  } catch (error) {
    // Members-only posts answer 404 (or 401/403) to anonymous callers.
    if (error instanceof RemoteSearchError && [400, 401, 403, 404, 410].includes(error.status)) throw unavailable(error.status)
    throw error
  }
  const fresh = normalizeSankakuPost(body)
  if (!fresh || fresh.id !== id) {
    throw new RemoteSearchError({ site: SITE.id, kind: 'upstream', message: 'Sankaku did not return this post' })
  }
  if (!fresh.fileUrl) throw unavailable(null, fresh.unavailable === 'deleted' ? 'Sankaku has deleted this post' : HIDDEN_MESSAGE)
  return fresh
}

export const sankakuAdapter = Object.freeze({
  id: SITE.id,
  label: SITE.label,
  transport: SITE.transport,
  pageSize: SITE.defaultLimit,
  translate,
  search,
  refresh,
})

export default sankakuAdapter
