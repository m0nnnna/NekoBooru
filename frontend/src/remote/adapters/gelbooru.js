import { normalizeTagName } from '../../utils/booruSearchTag.js'
import { translateQuery } from '../queryTranslation.js'
import {
  RemoteSearchError,
  booruDisplayNames,
  effectiveLimit,
  makeKey,
  mediaTypeFromExt,
  siteById,
} from '../types.js'

// Gelbooru through NekoBooru's relay (GET /api/booru-search/gelbooru, section
// 2.4 of docs/booru-search-plan.md): the browser cannot call Gelbooru itself
// (no CORS header, and the API key must stay on the server). The relay hands
// back Gelbooru's raw dapi rows; this file is the only place they are read.

const SITE = 'gelbooru'
const SITE_INFO = siteById(SITE)
const POST_PAGE = 'https://gelbooru.com/index.php?page=post&s=view&id='
// The relay accepts pages 1..500; Gelbooru refuses offsets past 20000.
const MAX_PAGE = 500
const MAX_OFFSET = 20000

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }
// 'Mon Oct 13 04:49:19 -0500 2026', Gelbooru's created_at.
const GELBOORU_DATE = /^[a-z]{3} ([a-z]{3}) (\d{1,2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/i
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

// Gelbooru's JSON HTML-escapes text fields ("girls&#039;_frontline").
function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? match
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

function httpUrl(value) {
  const url = String(value ?? '').trim()
  if (url.startsWith('//')) return `https:${url}`
  return /^https?:\/\//i.test(url) ? url : null
}

function intOrNull(value) {
  const number = Number(value)
  return value !== null && value !== '' && Number.isFinite(number) ? Math.trunc(number) : null
}

function textOrNull(value) {
  const text = decodeEntities(value).trim()
  return text || null
}

function extFrom(...names) {
  for (const name of names) {
    const path = String(name ?? '').split(/[?#]/)[0]
    const match = /\.([a-z0-9]+)$/i.exec(path)
    if (match) return match[1].toLowerCase()
  }
  return ''
}

// Same mapping as site_imports._safety on the backend.
function safetyFor(rating) {
  if (rating === 'e' || rating === 'explicit') return 'unsafe'
  if (['q', 'questionable', 's', 'sensitive'].includes(rating)) return 'sketchy'
  return 'safe'
}

function createdAtIso(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = GELBOORU_DATE.exec(text)
  const month = match && MONTHS[match[1].toLowerCase()]
  const parsed = month
    ? Date.parse(`${match[7]}-${month}-${match[2].padStart(2, '0')}T${match[3]}${match[4]}${match[5]}:${match[6]}`)
    : Date.parse(text)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/** One raw Gelbooru dapi post row -> RemotePost (section 3.2), or null without a usable id. */
export function normalizeGelbooruPost(row) {
  if (!row || typeof row !== 'object') return null
  const numericId = intOrNull(row.id)
  if (!numericId || numericId < 1) return null
  const id = String(numericId)

  const rawTags = decodeEntities(row.tags).split(/\s+/).filter(Boolean)
  const tags = [...new Set(rawTags.map(normalizeTagName).filter(Boolean))]
  // Search results carry no categories; the import queue resolves them later.
  const tagCategories = Object.fromEntries(tags.map((tag) => [tag, 'general']))

  const fileUrl = httpUrl(row.file_url)
  const fileExt = extFrom(row.image, row.file_url)
  const mediaType = mediaTypeFromExt(fileExt)
  const sampleUrl = httpUrl(row.sample_url)
  const rawRating = String(row.rating ?? '').trim().toLowerCase()

  return {
    key: makeKey(SITE, id),
    site: SITE,
    id,
    postUrl: `${POST_PAGE}${id}`,
    thumbUrl: httpUrl(row.preview_url),
    // A video's "sample" is never a playable stand-in for the original.
    sampleUrl: sampleUrl && sampleUrl !== fileUrl && mediaType !== 'video' ? sampleUrl : null,
    fileUrl,
    width: intOrNull(row.width),
    height: intOrNull(row.height),
    fileExt,
    mediaType,
    fileSize: null, // the dapi post rows carry no file size
    safety: safetyFor(rawRating),
    rawRating,
    tags,
    tagCategories,
    tagDisplayNames: booruDisplayNames(rawTags),
    source: textOrNull(row.source),
    md5: /^[0-9a-f]{32}$/i.test(String(row.md5 ?? '')) ? String(row.md5).toLowerCase() : null,
    score: intOrNull(row.score),
    createdAt: createdAtIso(row.created_at),
    unavailable: fileUrl ? null : String(row.status ?? '').toLowerCase() === 'deleted' ? 'deleted' : 'no-file',
    referer: SITE_INFO.referer,
  }
}

// The relay already turns a single-object `post` into a list; stay lenient anyway.
function rowsOf(posts) {
  if (Array.isArray(posts)) return posts
  return posts && typeof posts === 'object' ? [posts] : []
}

function nextCursorFor(page, limit, rowCount, total) {
  if (rowCount < limit || page >= MAX_PAGE || page * limit >= MAX_OFFSET) return null
  if (total !== null && page * limit >= total) return null
  return { page: page + 1 }
}

function pageFrom(cursor) {
  const page = Math.floor(Number(cursor?.page))
  return Number.isFinite(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1
}

// The api client's error (status + detail from the relay) -> RemoteSearchError.
function relayError(error) {
  if (error?.name === 'AbortError' || error instanceof RemoteSearchError) return error
  const status = Number.isInteger(error?.status) ? error.status : null
  const detail = error?.detail
  const code = detail && typeof detail === 'object' ? detail.code : null
  const message = error?.message || ''
  let kind = 'upstream'
  let retryAfterMs = null
  if (status === null) kind = 'network'
  else if (status === 403 && code === 'booru_search_disabled') kind = 'disabled'
  else if (status === 400 && code === 'gelbooru_credentials_missing') kind = 'credentials'
  else if (status === 429 || status === 503 || code === 'upstream_throttled') {
    kind = 'throttled'
    const seconds = Number(detail && typeof detail === 'object' ? detail.retryAfter : NaN)
    retryAfterMs = seconds > 0 ? Math.round(seconds * 1000) : null
  } else if (status === 400 && !code) kind = 'query'
  return new RemoteSearchError({ site: SITE, status, message, retryAfterMs, kind })
}

export const gelbooruAdapter = Object.freeze({
  id: SITE,
  label: SITE_INFO.label,
  transport: SITE_INFO.transport,
  pageSize: SITE_INFO.defaultLimit,

  translate(query, options) {
    return translateQuery(SITE, query, options)
  },

  /**
   * @param {{ query: string, options: import('../types.js').QueryOptions, cursor: { page: number }|null,
   *   signal?: AbortSignal, api: { searchGelbooru: Function }, limit?: number|string|null }} args
   *   `limit` is the home per-page choice; missing or 'default' means Gelbooru's own 42.
   */
  async search({ query, options, cursor = null, signal, api, limit: requested = null }) {
    const translation = translateQuery(SITE, query, options)
    const page = pageFrom(cursor)
    const limit = effectiveLimit(SITE, requested)
    let payload
    try {
      payload = await api.searchGelbooru({ tags: translation.tags, page, limit }, signal)
    } catch (error) {
      throw relayError(error)
    }
    const rows = rowsOf(payload?.posts)
    const total = intOrNull(payload?.total)
    return {
      posts: rows.map(normalizeGelbooruPost).filter(Boolean),
      nextCursor: nextCursorFor(page, limit, rows.length, total),
      total,
      totalIsEstimate: false,
      ignoredTerms: translation.ignored,
      note: translation.note,
    }
  },

  // Gelbooru file URLs do not expire, so the post found by search is current.
  async refresh(post) {
    if (post?.fileUrl) return post
    throw new RemoteSearchError({
      site: SITE,
      kind: 'unavailable',
      message: `Gelbooru did not return an original file for post ${post?.id ?? '?'}`,
    })
  },
})
