import { describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/danbooru.json'
import { RemoteSearchError } from '../types.js'
import { DANBOORU_PAGE_CAP, danbooruAdapter, normalizeDanbooruPost } from './danbooru.js'

const [pngRow, mp4Row, ugoiraRow, bannedRow] = fixture.posts
const ALL = { safe: true, sketchy: true, unsafe: true }

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : structuredClone(body)),
  }
}

function fetchReturning(...responses) {
  const fetch = vi.fn()
  for (const response of responses) fetch.mockResolvedValueOnce(response)
  return fetch
}

function requestedUrl(fetch, call = 0) {
  return new URL(fetch.mock.calls[call][0])
}

async function searchWith(rows, args = {}) {
  const fetch = fetchReturning(jsonResponse(rows))
  const result = await danbooruAdapter.search({ query: 'cat_ears', options: { safety: ALL }, cursor: null, fetch, ...args })
  return { fetch, result }
}

describe('danbooruAdapter shape', () => {
  it('is a frozen adapter for the danbooru site', () => {
    expect(Object.isFrozen(danbooruAdapter)).toBe(true)
    expect(danbooruAdapter).toMatchObject({ id: 'danbooru', label: 'Danbooru', transport: 'browser', pageSize: 20 })
  })

  it('translate() exposes the query translation, including the two-term budget', () => {
    const translation = danbooruAdapter.translate('cat_ears blue_archive', { safety: { safe: true, sketchy: false, unsafe: false } })
    expect(translation.terms).toEqual(['cat_ears', 'blue_archive'])
    expect(translation.ignored).toEqual(['rating:g'])
    expect(translation.note).toMatch(/2 search terms/)
  })
})

describe('normalizeDanbooruPost', () => {
  it('maps a png post: key, urls, dims and metadata', () => {
    const post = normalizeDanbooruPost(pngRow)
    expect(post).toMatchObject({
      key: 'danbooru:12370916',
      site: 'danbooru',
      id: '12370916',
      postUrl: 'https://danbooru.donmai.us/posts/12370916',
      thumbUrl: 'https://cdn.donmai.us/360x360/1a/fe/1afe4a4b32b9460b7ec9fe9b77390513.jpg',
      sampleUrl: 'https://cdn.donmai.us/sample/1a/fe/sample-1afe4a4b32b9460b7ec9fe9b77390513.jpg',
      fileUrl: 'https://cdn.donmai.us/original/1a/fe/1afe4a4b32b9460b7ec9fe9b77390513.png',
      width: 2723,
      height: 3008,
      fileExt: 'png',
      mediaType: 'image',
      fileSize: 1795595,
      safety: 'safe',
      rawRating: 'g',
      source: 'https://i.pximg.net/img-original/img/2026/10/13/12/00/25/150799323_p0.png',
      md5: '1afe4a4b32b9460b7ec9fe9b77390513',
      score: 3,
      createdAt: '2026-10-13T04:49:19.383Z',
      unavailable: null,
      referer: 'https://danbooru.donmai.us/',
    })
    expect(post).not.toHaveProperty('tag_string_general')
    expect(post).not.toHaveProperty('media_asset')
  })

  it('uses the 360x360 variant as the thumbnail, falling back to preview_file_url', () => {
    expect(normalizeDanbooruPost(mp4Row).thumbUrl).toBe('https://cdn.donmai.us/360x360/fe/ac/feace8b8e57900e58af3244ffaf7bc20.jpg')
    const noVariants = { ...pngRow, media_asset: { ...pngRow.media_asset, variants: pngRow.media_asset.variants.filter((v) => v.type !== '360x360') } }
    expect(normalizeDanbooruPost(noVariants).thumbUrl).toBe(pngRow.preview_file_url)
    expect(normalizeDanbooruPost({ ...pngRow, media_asset: undefined }).thumbUrl).toBe(pngRow.preview_file_url)
  })

  it('takes large_file_url (the webm) as the file of an ugoira zip', () => {
    const post = normalizeDanbooruPost(ugoiraRow)
    expect(post.fileExt).toBe('zip')
    expect(post.mediaType).toBe('video')
    expect(post.fileUrl).toBe('https://cdn.donmai.us/sample/75/39/sample-7539b7c9eb620eab1df7593d73dd02c5.webm')
    expect(post.fileUrl).not.toBe(ugoiraRow.file_url)
    expect(post.sampleUrl).toBe('https://cdn.donmai.us/720x720/75/39/7539b7c9eb620eab1df7593d73dd02c5.webp')
    const noWebm = normalizeDanbooruPost({ ...ugoiraRow, large_file_url: undefined, media_asset: { variants: [] } })
    expect(noWebm).toMatchObject({ fileUrl: null, unavailable: 'no-file' })
  })

  it('maps an mp4 to a video whose file is the original', () => {
    const post = normalizeDanbooruPost(mp4Row)
    expect(post).toMatchObject({ mediaType: 'video', fileExt: 'mp4', fileUrl: mp4Row.file_url, width: 1400, height: 1400 })
    expect(post.sampleUrl).toMatch(/\/720x720\/.+\.webp$/)
  })

  it('takes tag categories from every tag_string_* field', () => {
    const post = normalizeDanbooruPost(pngRow)
    expect(post.tagCategories).toMatchObject({
      aventador: 'artist',
      blue_archive: 'copyright',
      mari_blue_archive: 'character',
      mari_track_blue_archive: 'character',
      '1girl': 'general',
      cat_ears: 'general',
      absurdres: 'meta',
    })
    expect(Object.keys(post.tagCategories).sort()).toEqual([...post.tags].sort())
    expect(post.tags.slice(0, 3)).toEqual(['aventador', 'blue_archive', 'doodle_sensei_blue_archive'])
    expect(new Set(post.tags).size).toBe(post.tags.length)
    expect(post.tags).not.toContain('danbooru_12370916')
    expect(post.tags.every((tag) => /^[\p{L}\p{N}_:.-]+$/u.test(tag))).toBe(true)
  })

  it('keeps display names, keyed by the flattened tag, only for tags that flattened', () => {
    expect(normalizeDanbooruPost(pngRow).tagDisplayNames).toEqual({
      doodle_sensei_blue_archive: 'doodle sensei (blue archive)',
      mari_blue_archive: 'mari (blue archive)',
      mari_track_blue_archive: 'mari (track) (blue archive)',
      sensei_blue_archive: 'sensei (blue archive)',
    })
    const ugoira = normalizeDanbooruPost(ugoiraRow)
    expect(ugoira.tagCategories.pine_pine_candy8181).toBe('artist')
    expect(ugoira.tagDisplayNames.pine_pine_candy8181).toBe('pine (pine candy8181)')
    // All-symbol tags ('?', '@_@') flatten to nothing and are dropped.
    expect(ugoira.tags).not.toContain('')
    expect(Object.keys(ugoira.tagDisplayNames)).not.toContain('')
  })

  it('maps every rating letter to a safety', () => {
    const cases = { g: 'safe', s: 'sketchy', q: 'sketchy', e: 'unsafe', G: 'safe', '': 'safe' }
    for (const [rating, safety] of Object.entries(cases)) {
      const post = normalizeDanbooruPost({ ...pngRow, rating })
      expect(post.safety, `rating ${rating}`).toBe(safety)
      expect(post.rawRating).toBe(rating.toLowerCase())
    }
  })

  it('marks a banned row (no URL keys at all) unavailable with a placeholder thumb', () => {
    const post = normalizeDanbooruPost(bannedRow)
    expect(bannedRow).not.toHaveProperty('file_url')
    expect(post).toMatchObject({ key: 'danbooru:12370595', thumbUrl: null, sampleUrl: null, fileUrl: null, md5: null, unavailable: 'banned' })
    expect(post.tagCategories['cho_kaguya-hime']).toBe('copyright')
    expect(post.tagDisplayNames['cho_kaguya-hime']).toBe('cho kaguya-hime!')
  })

  it('tells hidden (Gold-only) and deleted rows apart', () => {
    const stripped = { ...bannedRow, is_banned: false }
    expect(normalizeDanbooruPost(stripped).unavailable).toBe('hidden')
    expect(normalizeDanbooruPost({ ...stripped, is_deleted: true }).unavailable).toBe('deleted')
    // Deleted posts still carry their URLs and stay importable.
    expect(normalizeDanbooruPost({ ...pngRow, is_deleted: true })).toMatchObject({ fileUrl: pngRow.file_url, unavailable: null })
  })

  it('drops rows without a numeric id', () => {
    expect(normalizeDanbooruPost(null)).toBeNull()
    expect(normalizeDanbooruPost({ ...pngRow, id: undefined })).toBeNull()
  })
})

describe('danbooruAdapter.search', () => {
  it('requests posts.json with the translated tags, page 1 and the default limit', async () => {
    const { fetch, result } = await searchWith(fixture.posts)
    const url = requestedUrl(fetch)
    expect(url.origin + url.pathname).toBe('https://danbooru.donmai.us/posts.json')
    expect([...url.searchParams]).toEqual([['tags', 'cat_ears'], ['page', '1'], ['limit', '20']])
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(result.posts.map((post) => post.key)).toEqual(['danbooru:12370916', 'danbooru:12371022', 'danbooru:12370555', 'danbooru:12370595'])
    expect(result).toMatchObject({ total: null, ignoredTerms: [], note: null })
  })

  it('sends the rating term and reports what the two-term budget cut', async () => {
    const { fetch, result } = await searchWith([], {
      query: 'cat_ears',
      options: { safety: { safe: true, sketchy: false, unsafe: false }, sort: 'id', order: 'asc' },
    })
    expect(requestedUrl(fetch).searchParams.get('tags')).toBe('cat_ears rating:g')
    expect(result.ignoredTerms).toEqual(['order:id'])
    expect(result.note).toMatch(/ignored: order:id/)
  })

  it('pages with { page } cursors and stops on a short page', async () => {
    const full = await searchWith(fixture.posts, { limit: 4 })
    expect(requestedUrl(full.fetch).searchParams.get('limit')).toBe('4')
    expect(full.result.nextCursor).toEqual({ page: 2 })

    const next = await searchWith(fixture.posts.slice(0, 2), { limit: 4, cursor: { page: 2 } })
    expect(requestedUrl(next.fetch).searchParams.get('page')).toBe('2')
    expect(next.result.nextCursor).toBeNull()
  })

  it('caps the requested limit at 200 and accepts it from options', async () => {
    const { fetch } = await searchWith([], { options: { safety: ALL, limit: 500 } })
    expect(requestedUrl(fetch).searchParams.get('limit')).toBe('200')
  })

  it('stops at the anonymous paging cap', async () => {
    const last = await searchWith(fixture.posts, { limit: 4, cursor: { page: DANBOORU_PAGE_CAP } })
    expect(last.result.nextCursor).toBeNull()
    const beyond = await searchWith(fixture.posts, { cursor: { page: DANBOORU_PAGE_CAP + 1 } })
    expect(beyond.fetch).not.toHaveBeenCalled()
    expect(beyond.result.posts).toEqual([])
  })

  it('maps 422 to a query error carrying Danbooru\'s message', async () => {
    const fetch = fetchReturning(jsonResponse(fixture.tagLimitError, { status: 422 }))
    const error = await danbooruAdapter.search({ query: 'a b', fetch }).catch((e) => e)
    expect(error).toBeInstanceOf(RemoteSearchError)
    expect(error).toMatchObject({ site: 'danbooru', status: 422, kind: 'query', message: 'You cannot search for more than 2 tags at a time.' })
  })

  it('maps 429 and 503 to throttled, reading Retry-After when exposed', async () => {
    const withHeader = fetchReturning(jsonResponse('{}', { status: 429, headers: { 'Retry-After': '30' } }))
    const throttled = await danbooruAdapter.search({ query: 'a', fetch: withHeader }).catch((e) => e)
    expect(throttled).toMatchObject({ kind: 'throttled', status: 429, retryAfterMs: 30000 })

    const unavailable = fetchReturning({ ok: false, status: 503, headers: new Headers(), json: async () => { throw new SyntaxError('html') } })
    const busy = await danbooruAdapter.search({ query: 'a', fetch: unavailable }).catch((e) => e)
    expect(busy).toMatchObject({ kind: 'throttled', status: 503, retryAfterMs: null })
  })

  it('maps other HTTP errors to upstream and fetch TypeErrors to network', async () => {
    const forbidden = await danbooruAdapter.search({ query: 'a', fetch: fetchReturning(jsonResponse({}, { status: 403 })) }).catch((e) => e)
    expect(forbidden).toMatchObject({ kind: 'upstream', status: 403 })

    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const offline = await danbooruAdapter.search({ query: 'a', fetch }).catch((e) => e)
    expect(offline).toBeInstanceOf(RemoteSearchError)
    expect(offline.kind).toBe('network')

    const notArray = await danbooruAdapter.search({ query: 'a', fetch: fetchReturning(jsonResponse({ success: false })) }).catch((e) => e)
    expect(notArray.kind).toBe('upstream')
  })

  it('lets an AbortError through untouched', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const fetch = vi.fn().mockRejectedValue(abort)
    await expect(danbooruAdapter.search({ query: 'a', fetch })).rejects.toBe(abort)
  })

  it('falls back to the global fetch', async () => {
    const fetch = fetchReturning(jsonResponse([]))
    vi.stubGlobal('fetch', fetch)
    try {
      await danbooruAdapter.search({ query: 'a' })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('danbooruAdapter.refresh', () => {
  it('fetches /posts/<id>.json and returns a fresh RemotePost', async () => {
    const fetch = fetchReturning(jsonResponse(pngRow))
    const stale = { ...normalizeDanbooruPost(pngRow), fileUrl: null }
    const post = await danbooruAdapter.refresh(stale, { fetch })
    expect(requestedUrl(fetch).href).toBe('https://danbooru.donmai.us/posts/12370916.json')
    expect(post.fileUrl).toBe(pngRow.file_url)
    expect(post).toEqual(normalizeDanbooruPost(pngRow))
  })

  it('throws unavailable when the fresh copy has no file', async () => {
    const fetch = fetchReturning(jsonResponse(bannedRow))
    const error = await danbooruAdapter.refresh(normalizeDanbooruPost(bannedRow), { fetch }).catch((e) => e)
    expect(error).toBeInstanceOf(RemoteSearchError)
    expect(error.kind).toBe('unavailable')
    expect(error.message).toMatch(/banned/)
  })

  it('rejects a non-numeric id without a request and a mismatched reply as upstream', async () => {
    const fetch = vi.fn()
    await expect(danbooruAdapter.refresh({ id: '../users' }, { fetch })).rejects.toMatchObject({ kind: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()

    const wrong = fetchReturning(jsonResponse(mp4Row))
    await expect(danbooruAdapter.refresh({ id: '12370916' }, { fetch: wrong })).rejects.toMatchObject({ kind: 'upstream' })
  })

  it('maps refresh errors like search errors', async () => {
    const fetch = fetchReturning(jsonResponse({ success: false, message: 'That record was not found.' }, { status: 404 }))
    await expect(danbooruAdapter.refresh({ id: '1' }, { fetch })).rejects.toMatchObject({ kind: 'upstream', status: 404, message: 'That record was not found.' })
  })
})
