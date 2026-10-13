import { normalizeTagName } from '../../utils/booruSearchTag.js'
import { retryAfterSeconds } from '../budget.js'
import { joinNotes, librarySpellingResolver, mapPlainTerms, resolveE621Name } from '../e621Names.js'
import { singlePlainTag, translateQuery } from '../queryTranslation.js'
import { timeoutSignal } from '../timeoutSignal.js'
import {
  RemoteSearchError,
  booruDisplayNames,
  effectiveLimit,
  makeKey,
  mediaTypeFromExt,
  siteById,
} from '../types.js'

// e621 / e926 search, straight from the browser (e621 answers with
// `Access-Control-Allow-Origin: *`). Section 1.3 and 3.5 of
// docs/booru-search-plan.md. e926 is e621's safe subset with the same ids, so
// one adapter searches e621.net and every key is 'e621:<id>'.

const SITE = 'e621'
const ORIGIN = 'https://e621.net'
// Browsers cannot set User-Agent; e621 asks API clients to identify
// themselves with this parameter instead, on every request.
export const E621_CLIENT = 'NekoBooru/1.0'
// Anonymous paging stops at page 750 (e621 API docs).
export const E621_PAGE_CAP = 750
export const E621_COUNT_TIMEOUT_MS = 10000

// e621 tag group -> NekoBooru category, in the order tags are listed. A tag's
// category is the first group it appears under; `invalid` is dropped.
const CATEGORY_MAP = [
  ['artist', 'artist'],
  ['contributor', 'artist'],
  ['copyright', 'copyright'],
  ['character', 'character'],
  ['species', 'general'],
  ['general', 'general'],
  ['lore', 'meta'],
  ['meta', 'meta'],
]

const SAFETY_BY_RATING = { s: 'safe', q: 'sketchy', e: 'unsafe' }

const FETCH_INIT = { headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' }

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function int(value) {
  const number = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? Math.trunc(number) : null
}

function isoDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeTags(groups) {
  const tags = []
  const tagCategories = {}
  const rawTags = []
  for (const [group, category] of CATEGORY_MAP) {
    const list = Array.isArray(groups?.[group]) ? groups[group] : []
    for (const raw of list) {
      const tag = normalizeTagName(raw)
      if (!tag || tag in tagCategories) continue
      tags.push(tag)
      tagCategories[tag] = category
      rawTags.push(raw)
    }
  }
  return { tags, tagCategories, tagDisplayNames: booruDisplayNames(rawTags) }
}

/** One raw e621 post row -> RemotePost (section 3.2). */
export function normalizeE621Post(row) {
  const id = String(row.id)
  const file = row.file || {}
  const preview = row.preview || {}
  const sample = row.sample || {}
  const fileExt = String(file.ext || '').trim().toLowerCase().replace(/^\./, '')
  const rawRating = String(row.rating || '').trim().toLowerCase()
  const fileUrl = text(file.url)
  // Deleted posts and posts behind e621's default anonymous blacklist both
  // come back with every URL null; only the deleted flag tells them apart.
  const unavailable = fileUrl ? null : (row.flags?.deleted ? 'deleted' : 'hidden')
  return {
    key: makeKey(SITE, id),
    site: SITE,
    id,
    postUrl: `${ORIGIN}/posts/${id}`,
    thumbUrl: text(preview.url),
    sampleUrl: sample.has ? text(sample.url) : null,
    fileUrl,
    width: int(file.width),
    height: int(file.height),
    fileExt,
    mediaType: mediaTypeFromExt(fileExt),
    fileSize: int(file.size),
    // An unknown rating letter counts as the strictest, so the rating
    // checkboxes never let it through by accident.
    safety: SAFETY_BY_RATING[rawRating] || 'unsafe',
    rawRating,
    ...normalizeTags(row.tags),
    source: (Array.isArray(row.sources) ? row.sources.map(text).find(Boolean) : null) || null,
    md5: text(file.md5),
    score: int(row.score?.total),
    createdAt: isoDate(row.created_at),
    unavailable,
    referer: siteById(SITE).referer,
  }
}

async function errorMessage(response) {
  try {
    const body = await response.json()
    return text(body?.message) || text(body?.reason) || null
  } catch {
    return null
  }
}

async function errorFor(response) {
  const status = response.status
  const message = await errorMessage(response)
  if (status === 429 || status === 503) {
    const seconds = retryAfterSeconds(response)
    return new RemoteSearchError({
      site: SITE,
      status,
      message: message || 'e621 is rate limiting requests',
      retryAfterMs: seconds === null ? null : seconds * 1000,
      kind: 'throttled',
    })
  }
  if (status === 422) return new RemoteSearchError({ site: SITE, status, message: message || 'e621 rejected the search', kind: 'query' })
  return new RemoteSearchError({ site: SITE, status, message: message || `e621 answered HTTP ${status}`, kind: 'upstream' })
}

// GET `url` as JSON. Abort errors pass through untouched; any other fetch
// failure is a network error, any HTTP error is mapped by errorFor().
async function getJson(url, { signal, fetch: fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch
  let response
  try {
    response = await doFetch(url, { ...FETCH_INIT, signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new RemoteSearchError({ site: SITE, message: `Could not reach e621: ${error?.message || error}`, kind: 'network' })
  }
  if (!response.ok) throw await errorFor(response)
  try {
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new RemoteSearchError({ site: SITE, status: response.status, message: 'e621 sent a response that is not JSON', kind: 'upstream' })
  }
}

export function e621SearchUrl(tags, page, limit) {
  const params = new URLSearchParams({ tags, page: String(page), limit: String(limit), _client: E621_CLIENT })
  return `${ORIGIN}/posts.json?${params}`
}

export function e621PostUrl(id) {
  return `${ORIGIN}/posts/${encodeURIComponent(id)}.json?${new URLSearchParams({ _client: E621_CLIENT })}`
}

export function e621TagUrl(tag) {
  return `${ORIGIN}/tags.json?${new URLSearchParams({ 'search[name_matches]': tag, _client: E621_CLIENT })}`
}

function pageFrom(cursor) {
  const page = Math.floor(Number(cursor?.page))
  return Number.isFinite(page) && page >= 1 ? page : 1
}

export const e621Adapter = Object.freeze({
  id: SITE,
  label: siteById(SITE).label,
  transport: 'browser',
  // The last page anonymous paging reaches (see the page-count cap in useRemoteResults).
  pageCap: () => E621_PAGE_CAP,
  pageCursor: (page) => ({ page }),
  // The booru's own page size; search() takes `limit` (the home per-page
  // choice) and resolves it with effectiveLimit().
  pageSize: siteById(SITE).defaultLimit,

  translate(query, options) {
    return translateQuery(SITE, query, options)
  },

  /**
   * @param {{ query: string, options: object, cursor: {page:number}|null, signal?: AbortSignal,
   *           api?: object, limit?: number|string|null, fetch?: typeof fetch, resolveName?: Function|null }} args
   * `fetch` defaults to the global one; tests inject a stub. Plain tags go
   * through `resolveName` (default: the cached e621 name resolver; null
   * skips it), so the library's hirasawa_yui searches yui_hirasawa.
   */
  async search({ query = '', options = {}, cursor = null, signal, api = null, limit = null, fetch, resolveName = resolveE621Name } = {}) {
    const translation = translateQuery(SITE, query, options)
    let terms = translation.terms
    let mappingNote = null
    if (resolveName) {
      const mapping = await mapPlainTerms(query, terms, resolveName, 'e621', { fetch, signal, librarySpelling: librarySpellingResolver(api) })
      terms = mapping.terms
      mappingNote = mapping.note
    }
    const page = pageFrom(cursor)
    const count = effectiveLimit(SITE, limit)
    const body = await getJson(e621SearchUrl(terms.join(' '), page, count), { signal, fetch })
    const rows = Array.isArray(body?.posts) ? body.posts : []
    const posts = rows.filter((row) => row && row.id !== null && row.id !== undefined).map(normalizeE621Post)
    const nextCursor = rows.length >= count && page < E621_PAGE_CAP ? { page: page + 1 } : null
    return { posts, nextCursor, total: null, ignoredTerms: translation.ignored, note: joinNotes(translation.note, mappingNote) }
  },

  // Only a single plain tag has a post count to estimate from.
  countable(query) {
    return singlePlainTag(query) !== null
  },

  /**
   * count(query, options, { signal, fetch, timeoutMs }) -> number|null
   * An estimate: the tag's post_count from tags.json, which ignores the
   * rating filter and the anonymous blacklist. Only for a query that is one
   * plain tag; null otherwise and on any failure, abort or timeout.
   */
  async count(query = '', options = {}, { signal, fetch, api = null, timeoutMs = E621_COUNT_TIMEOUT_MS, resolveName = resolveE621Name } = {}) {
    let tag = singlePlainTag(query)
    if (!tag) return null
    const doFetch = fetch || globalThis.fetch
    const linked = timeoutSignal(signal, timeoutMs)
    try {
      // The tag the search really asked for (see search()): the library's
      // flattened spelling un-flattened, then e621's name for it.
      const librarySpelling = librarySpellingResolver(api)
      if (librarySpelling) tag = (await librarySpelling(tag)) || tag
      if (resolveName) tag = (await resolveName(tag, { fetch, signal: linked.signal })) || tag
      const response = await doFetch(e621TagUrl(tag), { ...FETCH_INIT, signal: linked.signal })
      if (!response?.ok) return null
      const body = await response.json()
      // An empty result is `{"tags": []}` rather than `[]`.
      const row = (Array.isArray(body) ? body : []).find((entry) => String(entry?.name ?? '').toLowerCase() === tag)
      const total = int(row?.post_count)
      return total !== null && total >= 0 ? total : null
    } catch {
      return null
    } finally {
      linked.done()
    }
  },
  countIsEstimate: true,

  /** One post by id (the booru post page opened from its URL), with or without a file. */
  async getPost(postId, { signal, fetch } = {}) {
    const id = String(postId ?? '')
    if (!/^\d+$/.test(id)) throw new RemoteSearchError({ site: SITE, message: `Not an e621 post id: ${id}`, kind: 'unavailable' })
    let body
    try {
      body = await getJson(e621PostUrl(id), { signal, fetch })
    } catch (error) {
      if (error instanceof RemoteSearchError && error.status === 404) {
        throw new RemoteSearchError({ site: SITE, status: 404, message: `e621 post ${id} no longer exists`, kind: 'unavailable' })
      }
      throw error
    }
    if (!body?.post) throw new RemoteSearchError({ site: SITE, message: `e621 returned no post ${id}`, kind: 'unavailable' })
    return normalizeE621Post(body.post)
  },

  /** A fresh copy of `post` right before import; throws kind 'unavailable' when it has no file. */
  async refresh(post, { signal, fetch } = {}) {
    const fresh = await e621Adapter.getPost(post.id, { signal, fetch })
    if (!fresh.fileUrl) {
      const reason = fresh.unavailable === 'deleted' ? 'was deleted' : 'is hidden from anonymous visitors'
      throw new RemoteSearchError({ site: SITE, message: `e621 post ${post.id} ${reason}`, kind: 'unavailable' })
    }
    return fresh
  },
})
