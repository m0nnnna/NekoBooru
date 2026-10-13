import { normalizeTagName } from '../../utils/booruSearchTag.js'
import { retryAfterSeconds } from '../budget.js'
import { translateQuery } from '../queryTranslation.js'
import { RemoteSearchError, booruDisplayNames, effectiveLimit, makeKey, mediaTypeFromExt, siteById } from '../types.js'

// Danbooru search adapter (sections 1.2 and 3.5 of docs/booru-search-plan.md).
// Browser-direct: posts.json sends `Access-Control-Allow-Origin: *`, so the
// request stays a simple CORS GET with nothing but an Accept header.

const SITE = 'danbooru'
const BASE = 'https://danbooru.donmai.us'
// Anonymous callers may not page past 1000 (docs).
export const DANBOORU_PAGE_CAP = 1000
// counts/posts.json can be slow on broad queries; the page count is a courtesy.
export const DANBOORU_COUNT_TIMEOUT_MS = 10000

// Same order as danbooruImportJob in browser-extension/site-import-core.js,
// so a search result and an extension import list the tags identically.
const TAG_FIELDS = [
  ['tag_string_artist', 'artist'],
  ['tag_string_copyright', 'copyright'],
  ['tag_string_character', 'character'],
  ['tag_string_general', 'general'],
  ['tag_string_meta', 'meta'],
]

// booruImportSafety in the extension: unknown ratings count as safe.
const RATING_SAFETY = { g: 'safe', s: 'sketchy', q: 'sketchy', e: 'unsafe' }

const FETCH_OPTIONS = { headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' }

function httpsUrl(value) {
  const url = String(value ?? '').trim()
  return /^https:\/\//i.test(url) ? url : null
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function isoOrNull(value) {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

function variantUrl(row, type) {
  const variants = Array.isArray(row.media_asset?.variants) ? row.media_asset.variants : []
  return httpsUrl(variants.find((variant) => variant?.type === type)?.url)
}

function tagsOf(row) {
  const tags = []
  const tagCategories = {}
  const rawTags = []
  for (const [field, category] of TAG_FIELDS) {
    for (const raw of String(row[field] || '').split(/\s+/)) {
      const tag = normalizeTagName(raw)
      if (!tag || tag in tagCategories) continue
      tags.push(tag)
      tagCategories[tag] = category
      rawTags.push(raw)
    }
  }
  return { tags, tagCategories, tagDisplayNames: booruDisplayNames(rawTags) }
}

// Why a row has no usable original. Banned posts (and Gold-only ones, to an
// anonymous caller) arrive without any URL or md5 keys; an ugoira whose webm
// is missing still has its zip, which NekoBooru cannot play.
function unavailableReason(row) {
  if (row.is_banned) return 'banned'
  if (row.is_deleted) return 'deleted'
  return row.file_url || row.md5 ? 'no-file' : 'hidden'
}

/** One posts.json row -> RemotePost (section 3.2), or null for a row without an id. */
export function normalizeDanbooruPost(row) {
  if (!row || typeof row !== 'object') return null
  const id = String(row.id ?? '').trim()
  if (!/^\d+$/.test(id)) return null
  const fileExt = String(row.file_ext || '').trim().toLowerCase().replace(/^\./, '')
  const mediaType = mediaTypeFromExt(fileExt)
  // Ugoira originals are zips of frames; large_file_url is Danbooru's webm of them.
  const fileUrl = fileExt === 'zip'
    ? httpsUrl(row.large_file_url) || variantUrl(row, 'sample')
    : httpsUrl(row.file_url)
  // The viewer's first paint wants a still: the sample for images, the
  // 720x720 webp poster for videos (their large_file_url is a video too).
  const sampleUrl = mediaType === 'video' ? variantUrl(row, '720x720') : httpsUrl(row.large_file_url)
  const rawRating = String(row.rating || '').trim().toLowerCase()
  return {
    key: makeKey(SITE, id),
    site: SITE,
    id,
    postUrl: `${BASE}/posts/${id}`,
    thumbUrl: variantUrl(row, '360x360') || httpsUrl(row.preview_file_url),
    sampleUrl,
    fileUrl,
    width: numberOrNull(row.image_width),
    height: numberOrNull(row.image_height),
    fileExt,
    mediaType,
    fileSize: numberOrNull(row.file_size),
    safety: RATING_SAFETY[rawRating] || 'safe',
    rawRating,
    ...tagsOf(row),
    source: String(row.source || '').trim() || null,
    md5: String(row.md5 || '').trim().toLowerCase() || null,
    score: numberOrNull(row.score),
    createdAt: isoOrNull(row.created_at),
    unavailable: fileUrl ? null : unavailableReason(row),
    referer: siteById(SITE).referer,
  }
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// GET a Danbooru JSON URL; every failure becomes a RemoteSearchError except
// an abort, which the caller started and expects back unchanged.
async function getJson(url, { signal, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  let response
  try {
    response = await doFetch(url, { ...FETCH_OPTIONS, signal })
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error
    throw new RemoteSearchError({ site: SITE, message: `Could not reach Danbooru: ${error?.message || error}`, kind: 'network' })
  }
  const body = await readJson(response)
  if (!response.ok) {
    const status = response.status
    const upstreamMessage = typeof body?.message === 'string' ? body.message : ''
    if (status === 429 || status === 503) {
      const seconds = retryAfterSeconds(response)
      throw new RemoteSearchError({
        site: SITE,
        status,
        message: upstreamMessage || `Danbooru is rate limiting requests (HTTP ${status})`,
        retryAfterMs: seconds === null ? null : seconds * 1000,
        kind: 'throttled',
      })
    }
    if (status === 422 && upstreamMessage) {
      throw new RemoteSearchError({ site: SITE, status, message: upstreamMessage, kind: 'query' })
    }
    throw new RemoteSearchError({ site: SITE, status, message: upstreamMessage || `Danbooru answered HTTP ${status}`, kind: 'upstream' })
  }
  if (body === null) throw new RemoteSearchError({ site: SITE, status: response.status, message: 'Danbooru sent a response that is not JSON', kind: 'upstream' })
  return body
}

function translate(query, options) {
  return translateQuery(SITE, query, options)
}

/**
 * search({ query, options, cursor, signal, api, limit, fetch })
 *   -> { posts, nextCursor, total, ignoredTerms, note }
 * `limit` is the home per-page choice (or `options.limit`); effectiveLimit()
 * turns "default" into Danbooru's 20 and caps numbers at 200. `fetch` is
 * injectable for tests and defaults to the global one. `api` is unused here.
 */
async function search({ query = '', options = {}, cursor = null, signal, limit, fetch } = {}) {
  const translation = translate(query, options)
  const page = Math.max(1, Math.floor(Number(cursor?.page) || 1))
  const pageLimit = effectiveLimit(SITE, limit ?? options?.limit)
  const result = { posts: [], nextCursor: null, total: null, ignoredTerms: translation.ignored, note: translation.note }
  if (page > DANBOORU_PAGE_CAP) return result

  const params = new URLSearchParams({ tags: translation.tags, page: String(page), limit: String(pageLimit) })
  const rows = await getJson(`${BASE}/posts.json?${params}`, { signal, fetch })
  if (!Array.isArray(rows)) {
    throw new RemoteSearchError({ site: SITE, message: 'Danbooru sent an unexpected search response', kind: 'upstream' })
  }
  result.posts = rows.map(normalizeDanbooruPost).filter(Boolean)
  // Judge "short page" by the raw row count: malformed rows are not the end.
  if (rows.length >= pageLimit && page < DANBOORU_PAGE_CAP) result.nextCursor = { page: page + 1 }
  return result
}

// An AbortSignal that fires when `signal` does or after `ms`.
function timeoutSignal(signal, ms) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener?.('abort', abort, { once: true })
  const timer = setTimeout(abort, ms)
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', abort)
    },
  }
}

/**
 * count(query, options, { signal, fetch, timeoutMs }) -> number|null
 * Exact number of posts the translated query matches, from
 * counts/posts.json (`{"counts":{"posts":N}}`, CORS allowed). Called once per
 * search, not per page; null on any failure, abort or timeout.
 */
async function count(query = '', options = {}, { signal, fetch, timeoutMs = DANBOORU_COUNT_TIMEOUT_MS } = {}) {
  const doFetch = fetch || globalThis.fetch
  const params = new URLSearchParams({ tags: translate(query, options).tags })
  const linked = timeoutSignal(signal, timeoutMs)
  try {
    const response = await doFetch(`${BASE}/counts/posts.json?${params}`, { ...FETCH_OPTIONS, signal: linked.signal })
    if (!response?.ok) return null
    const value = (await readJson(response))?.counts?.posts
    const total = typeof value === 'number' ? value : Number.NaN
    return Number.isFinite(total) && total >= 0 ? Math.floor(total) : null
  } catch {
    return null
  } finally {
    linked.done()
  }
}

/** A fresh copy of one post right before import; throws kind 'unavailable' without an original. */
async function refresh(post, { signal, fetch } = {}) {
  const id = String(post?.id ?? '')
  if (!/^\d+$/.test(id)) {
    throw new RemoteSearchError({ site: SITE, message: `Not a Danbooru post id: ${id}`, kind: 'unavailable' })
  }
  const fresh = normalizeDanbooruPost(await getJson(`${BASE}/posts/${id}.json`, { signal, fetch }))
  if (!fresh || fresh.id !== id) {
    throw new RemoteSearchError({ site: SITE, message: `Danbooru did not return post #${id}`, kind: 'upstream' })
  }
  if (!fresh.fileUrl) {
    const why = fresh.unavailable === 'hidden' ? ' (it may need a Danbooru Gold account)' : ''
    throw new RemoteSearchError({ site: SITE, message: `Danbooru post #${id} has no downloadable file: ${fresh.unavailable}${why}`, kind: 'unavailable' })
  }
  return fresh
}

// Shared with remote/danbooruCategories.js, the import-time tag category lookup.
export { BASE as DANBOORU_ORIGIN, FETCH_OPTIONS as DANBOORU_FETCH_OPTIONS, readJson, timeoutSignal }

const site = siteById(SITE)

export const danbooruAdapter = Object.freeze({
  id: SITE,
  label: site.label,
  transport: site.transport,
  // Requests use effectiveLimit(); this is the default for callers that ask.
  pageSize: site.defaultLimit,
  translate,
  search,
  refresh,
  count,
  countIsEstimate: false,
})
