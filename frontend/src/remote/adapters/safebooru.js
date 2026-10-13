// Safebooru adapter (section 3.5 of docs/booru-search-plan.md). Safebooru's
// dapi sends no CORS header, so searches go through the backend relay
// GET /api/booru-search/safebooru, which answers
// { site, page, limit, total: number|null, posts: [raw dapi rows] }. Normalising
// those rows into RemotePosts happens here and nowhere else.
//
// Safebooru gives no tag categories (section 1.6): every tag is 'general'
// here, and the import queue resolves them through Danbooru at import time
// (P7, remote/danbooruCategories.js).
import { normalizeTagName } from '../../utils/booruSearchTag.js'
import { decodeEntities } from '../htmlEntities.js'
import { translateQuery } from '../queryTranslation.js'
import { RemoteSearchError, booruDisplayNames, effectiveLimit, makeKey, mediaTypeFromExt, siteById } from '../types.js'

const SITE = 'safebooru'
const ORIGIN = 'https://safebooru.org'
const SITE_ENTRY = siteById(SITE)
// The relay accepts page 1..500; asking past that is a 400, so stop there.
export const SAFEBOORU_MAX_PAGE = 500

const SAFETY_BY_RATING = {
  general: 'safe', safe: 'safe', g: 'safe', s: 'safe',
  sensitive: 'sketchy', questionable: 'sketchy', q: 'sketchy',
  explicit: 'unsafe', e: 'unsafe',
}

// Unknown or missing ratings count as safe, like the extension's
// booruImportSafety; the site only hosts safe-ish content anyway.
export function safebooruSafety(rawRating) {
  return SAFETY_BY_RATING[String(rawRating ?? '').trim().toLowerCase()] || 'safe'
}

// An https URL on any host, or null. Protocol-relative and root-relative
// paths (seen on older dapi mirrors) are resolved against safebooru.org.
function absoluteUrl(value) {
  const text = decodeEntities(value).trim()
  if (!text) return null
  const resolved = text.startsWith('//') ? `https:${text}` : text.startsWith('/') ? `${ORIGIN}${text}` : text
  return /^https:\/\/[^\s/]+\//i.test(resolved) ? resolved : null
}

function positiveInt(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * The row's own URLs when present (verified live: preview_url, sample_url and
 * file_url are full https URLs). Fallback built from `directory` + `image`:
 *   file    https://safebooru.org/images/<dir>/<image>
 *   sample  https://safebooru.org/samples/<dir>/sample_<stem>.jpg   (only when `sample` is true)
 *   preview https://safebooru.org/thumbnails/<dir>/thumbnail_<stem>.jpg
 * When `sample` is false Safebooru repeats the original as sample_url; that
 * is not a mid-size copy, so sampleUrl is null then.
 */
export function safebooruUrls(row) {
  const directory = String(row?.directory ?? '').trim()
  const image = decodeEntities(row?.image).trim()
  const canBuild = /^[\w-]+$/.test(directory) && /^[\w-]+\.[a-z0-9]+$/i.test(image)
  const stem = canBuild ? image.replace(/\.[^.]+$/, '') : ''
  const fileUrl = absoluteUrl(row?.file_url) || (canBuild ? `${ORIGIN}/images/${directory}/${image}` : null)
  const thumbUrl = absoluteUrl(row?.preview_url) || (canBuild ? `${ORIGIN}/thumbnails/${directory}/thumbnail_${stem}.jpg` : null)
  let sampleUrl = null
  if (row?.sample === true || row?.sample === 1 || row?.sample === '1' || row?.sample === 'true') {
    sampleUrl = absoluteUrl(row?.sample_url) || (canBuild ? `${ORIGIN}/samples/${directory}/sample_${stem}.jpg` : null)
    if (sampleUrl === fileUrl) sampleUrl = null
  }
  return { fileUrl, sampleUrl, thumbUrl }
}

function extensionOf(row, fileUrl) {
  const name = decodeEntities(row?.image).trim() || (fileUrl ? new URL(fileUrl).pathname : '')
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return match ? match[1].toLowerCase() : ''
}

/** One raw dapi row -> RemotePost, or null for a row without a usable id. */
export function normalizeSafebooruPost(row) {
  const numericId = positiveInt(row?.id)
  if (!numericId) return null
  const id = String(numericId)
  const rawTags = decodeEntities(row.tags).split(/\s+/).filter(Boolean)
  const tags = []
  const tagCategories = {}
  for (const raw of rawTags) {
    const tag = normalizeTagName(raw)
    if (!tag || tag in tagCategories) continue
    tags.push(tag)
    tagCategories[tag] = 'general'
  }
  const { fileUrl, sampleUrl, thumbUrl } = safebooruUrls(row)
  const fileExt = extensionOf(row, fileUrl)
  const rawRating = String(row.rating ?? '').trim().toLowerCase()
  const md5 = String(row.hash ?? '').trim().toLowerCase()
  const changed = finiteNumber(row.change)
  const status = String(row.status ?? '').trim().toLowerCase()
  return {
    key: makeKey(SITE, id),
    site: SITE,
    id,
    postUrl: `${ORIGIN}/index.php?page=post&s=view&id=${id}`,
    thumbUrl,
    sampleUrl,
    fileUrl,
    width: positiveInt(row.width),
    height: positiveInt(row.height),
    fileExt,
    mediaType: mediaTypeFromExt(fileExt),
    fileSize: null, // the dapi row has no size
    safety: safebooruSafety(rawRating),
    rawRating,
    tags,
    tagCategories,
    tagDisplayNames: booruDisplayNames(rawTags),
    source: decodeEntities(row.source).trim() || null,
    md5: /^[0-9a-f]{32}$/.test(md5) ? md5 : null,
    score: finiteNumber(row.score),
    // The dapi JSON has no creation time; `change` (last edit, unix seconds)
    // is the closest it offers.
    createdAt: changed !== null && changed > 0 ? new Date(changed * 1000).toISOString() : null,
    unavailable: fileUrl ? null : status === 'deleted' ? 'deleted' : 'no-file',
    referer: SITE_ENTRY.referer,
  }
}

// The api client's ApiError (api/request.js): `kind` says whether the backend
// answered ('http', with `status` and the relay's `detail`) or could not be
// reached ('network'); `retryAfterMs` comes from Retry-After or detail.retryAfter.
export function safebooruError(error) {
  if (error?.name === 'AbortError' || error instanceof RemoteSearchError) return error
  const status = error?.kind === 'http' && Number.isInteger(error.status) ? error.status : null
  const detail = error?.detail
  const code = detail && typeof detail === 'object' ? detail.code : null
  const message = (detail && typeof detail === 'object' ? detail.message : null) || error?.message || ''
  let kind = 'upstream'
  let retryAfterMs = null
  if (error?.kind === 'network') kind = 'network'
  else if (status === null) kind = 'upstream'
  else if (status === 429 || status === 503 || code === 'upstream_throttled') {
    kind = 'throttled'
    retryAfterMs = error.retryAfterMs > 0 ? error.retryAfterMs : null
  } else if (status === 403 && code === 'booru_search_disabled') kind = 'disabled'
  else if (status === 400) kind = 'query' // the relay's own parameter check (e.g. tags over 500 chars)
  return new RemoteSearchError({ site: SITE, status, message, retryAfterMs, kind })
}

export const safebooruAdapter = Object.freeze({
  id: SITE,
  label: SITE_ENTRY.label,
  transport: SITE_ENTRY.transport,
  pageSize: SITE_ENTRY.defaultLimit,
  pageCap: () => SAFEBOORU_MAX_PAGE,
  pageCursor: (page) => ({ page }),

  translate(query, options) {
    return translateQuery(SITE, query, options)
  },

  /**
   * `limit` is the home per-page choice (undefined/'default' -> Safebooru's 42);
   * cursor is { page } (1-based), null for the first page.
   */
  async search({ query = '', options = {}, cursor = null, signal, api, limit } = {}) {
    const translated = translateQuery(SITE, query, options)
    const page = positiveInt(cursor?.page) || 1
    const requested = effectiveLimit(SITE, limit)
    let response
    try {
      response = await api.searchSafebooru({ tags: translated.tags, page, limit: requested }, signal)
    } catch (error) {
      throw safebooruError(error)
    }
    const rows = Array.isArray(response?.posts) ? response.posts : []
    const posts = rows.map(normalizeSafebooruPost).filter(Boolean)
    // The relay's total (the dapi's count attribute) is exact when present;
    // null means unknown, and then a page shorter than asked is the last.
    const total = Number.isInteger(response?.total) && response.total >= 0 ? response.total : null
    const pageLimit = positiveInt(response?.limit) || requested
    const exhausted = rows.length < pageLimit || page >= SAFEBOORU_MAX_PAGE || (total !== null && page * pageLimit >= total)
    return {
      posts,
      nextCursor: exhausted ? null : { page: page + 1 },
      total,
      totalIsEstimate: false,
      ignoredTerms: translated.ignored,
      note: translated.note,
    }
  },

  // Safebooru URLs are stable, so the searched post is already fresh.
  async refresh(post) {
    if (post?.fileUrl) return post
    throw new RemoteSearchError({
      site: SITE,
      message: `Safebooru post ${post?.id ?? ''} has no original file`.trim(),
      kind: 'unavailable',
    })
  },
})
