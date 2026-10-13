import { describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/sankaku.json'
import { RemoteSearchError } from '../types.js'
import { HIDDEN_MESSAGE, normalizeSankakuPost, sankakuAdapter, sankakuSafety } from './sankaku.js'

const clone = (value) => JSON.parse(JSON.stringify(value))
const ALL = { safety: { safe: true, sketchy: true, unsafe: true }, sort: 'date', order: 'desc' }

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function stubFetch(...responses) {
  const queue = [...responses]
  return vi.fn(async () => {
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  })
}

async function searchError(fetch, args = {}) {
  try {
    await sankakuAdapter.search({ query: 'azur_lane', options: ALL, fetch, ...args })
  } catch (error) {
    return error
  }
  throw new Error('search did not throw')
}

describe('sankakuAdapter.search', () => {
  it('requests the keyset endpoint with translated tags, the default limit and no referrer', async () => {
    const fetch = stubFetch(jsonResponse(fixture.keyset))
    const options = { safety: { safe: true, sketchy: false, unsafe: false }, sort: 'date', order: 'desc' }
    await sankakuAdapter.search({ query: 'azur_lane', options, cursor: null, fetch, signal: undefined })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://sankakuapi.com/posts/keyset')
    expect(parsed.searchParams.get('tags')).toBe('azur_lane -rating:q -rating:e')
    expect(parsed.searchParams.get('limit')).toBe('20')
    expect(parsed.searchParams.has('next')).toBe(false)
    expect(init).toMatchObject({ headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' })
  })

  it('sends the keyset cursor and caps the requested limit at 100', async () => {
    const fetch = stubFetch(jsonResponse(fixture.keyset))
    await sankakuAdapter.search({ query: '', options: ALL, cursor: { next: 'abc123' }, limit: 500, fetch })
    const parsed = new URL(fetch.mock.calls[0][0])
    expect(parsed.searchParams.get('next')).toBe('abc123')
    expect(parsed.searchParams.get('limit')).toBe('100')
    expect(parsed.searchParams.get('tags')).toBe('')
  })

  it('normalizes the image post', async () => {
    const result = await sankakuAdapter.search({ query: '', options: ALL, fetch: stubFetch(jsonResponse(fixture.keyset)) })
    expect(result.posts).toHaveLength(2)
    const [image] = result.posts
    const raw = fixture.keyset.data[0]
    expect(image).toMatchObject({
      key: 'sankaku:e8M5qw7OgMz',
      site: 'sankaku',
      id: 'e8M5qw7OgMz',
      postUrl: 'https://sankaku.app/posts/e8M5qw7OgMz',
      thumbUrl: raw.preview_url,
      sampleUrl: raw.sample_url,
      fileUrl: raw.file_url,
      width: 4134,
      height: 7087,
      fileExt: 'jpg',
      mediaType: 'image',
      fileSize: 7611699,
      safety: 'safe',
      rawRating: 's',
      source: 'removed',
      md5: '9df693db59692c9b718446eec95c12ce',
      score: 16,
      createdAt: new Date(1791793067 * 1000).toISOString(),
      unavailable: null,
      referer: 'https://sankaku.app/',
    })
    expect(image.tags).toEqual(['azur_lane', 'superb_azur_lane', 'hci', 'labcoat', 'long_hair', '1girl', 'high_resolution'])
    expect(image.tagCategories).toMatchObject({ azur_lane: 'copyright', superb_azur_lane: 'character', hci: 'artist', labcoat: 'general' })
    expect(image.tagDisplayNames).toEqual({ superb_azur_lane: 'superb (azur lane)', hci: 'hci+' })
    expect(image).not.toHaveProperty('tag_names')
  })

  it('normalizes the video post without a video sample and maps genre/medium tags', async () => {
    const result = await sankakuAdapter.search({ query: '', options: ALL, fetch: stubFetch(jsonResponse(fixture.keyset)) })
    const video = result.posts[1]
    expect(video).toMatchObject({ key: 'sankaku:YEa7oYL93am', fileExt: 'mp4', mediaType: 'video', sampleUrl: null, width: 1440, height: 2040 })
    expect(video.thumbUrl).toMatch(/\.avif\?/)
    expect(video.createdAt).toBe('2026-10-11T22:22:35.000Z')
    const withNanos = { ...clone(fixture.keyset.data[1]), created_at: { json_class: 'Time', s: 1791757355, n: 250000000 } }
    expect(normalizeSankakuPost(withNanos).createdAt).toBe('2026-10-11T22:22:35.250Z')
    expect(video.tagCategories).toMatchObject({ crossover: 'general', portrait: 'meta', ayanami_rei: 'character', h264_codec: 'general' })
    expect(video.tagDisplayNames).toEqual({ h264_codec: 'h264 (codec)' })
  })

  it('returns the meta.next cursor, and none when it is missing or the page is empty', async () => {
    const first = await sankakuAdapter.search({ query: '', options: ALL, fetch: stubFetch(jsonResponse(fixture.keyset)) })
    expect(first).toMatchObject({ nextCursor: { next: 'fdce2a7b059aba501af38aa7908cea81' }, total: null, ignoredTerms: [], note: null })

    const last = clone(fixture.keyset)
    last.meta.next = null
    expect((await sankakuAdapter.search({ query: '', options: ALL, fetch: stubFetch(jsonResponse(last)) })).nextCursor).toBeNull()

    const empty = { meta: { next: 'ffff', prev: null }, data: [] }
    const result = await sankakuAdapter.search({ query: '', options: ALL, fetch: stubFetch(jsonResponse(empty)) })
    expect(result).toMatchObject({ posts: [], nextCursor: null })
  })

  it('reports query terms Sankaku does not get', async () => {
    const fetch = stubFetch(jsonResponse(fixture.keyset))
    const result = await sankakuAdapter.search({ query: 'cat ~dog fav:me', options: { ...ALL, order: 'asc' }, fetch })
    expect(result.ignoredTerms).toEqual(['~dog', 'fav:me', 'oldest-first'])
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('tags')).toBe('cat')
    expect(sankakuAdapter.translate('cat ~dog', ALL).ignored).toEqual(['~dog'])
  })
})

describe('normalizeSankakuPost', () => {
  const row = (patch) => ({ ...clone(fixture.keyset.data[0]), ...patch })

  it('maps every rating letter to a safety', () => {
    expect(['s', 'q', 'e', 'Q', '', null].map((rating) => normalizeSankakuPost(row({ rating })).safety))
      .toEqual(['safe', 'sketchy', 'unsafe', 'sketchy', 'safe', 'safe'])
    expect(normalizeSankakuPost(row({ rating: 'Q' })).rawRating).toBe('q')
    expect(sankakuSafety('explicit')).toBe('unsafe')
  })

  it('maps tag types 0-5, 8, 9 and unknown numbers', () => {
    const types = [0, 1, 2, 3, 4, 5, 8, 9, 7]
    const tags = types.map((type) => ({ tagName: `t${type}`, type }))
    expect(normalizeSankakuPost(row({ tags })).tagCategories).toEqual({
      t0: 'general', t1: 'artist', t2: 'artist', t3: 'copyright', t4: 'character', t5: 'general', t8: 'meta', t9: 'meta', t7: 'general',
    })
  })

  it('falls back to name_en when tagName is missing, and dedupes keeping the first category', () => {
    const tags = [
      { name_en: 'Miyu (Blue Archive)', type: 4 },
      { tagName: 'miyu_(blue_archive)', type: 0 },
      { tagName: '', name_en: '', type: 0 },
    ]
    const post = normalizeSankakuPost(row({ tags }))
    expect(post.tags).toEqual(['miyu_blue_archive'])
    expect(post.tagCategories).toEqual({ miyu_blue_archive: 'character' })
    expect(post.tagDisplayNames).toEqual({ miyu_blue_archive: 'miyu (blue archive)' })
  })

  it('uses tag_names as general tags when the tag rows are absent', () => {
    const post = normalizeSankakuPost(row({ tags: [], tag_names: ['Cat_Ears', 'solo'] }))
    expect(post.tags).toEqual(['cat_ears', 'solo'])
    expect(post.tagCategories).toEqual({ cat_ears: 'general', solo: 'general' })
  })

  it('marks posts without a file_url as hidden (or deleted)', () => {
    const hidden = normalizeSankakuPost(row({ file_url: null, redirect_to_signup: true }))
    expect(hidden).toMatchObject({ fileUrl: null, unavailable: 'hidden', fileExt: 'jpg' })
    expect(hidden.thumbUrl).toBe(fixture.keyset.data[0].preview_url)
    const missing = row({})
    delete missing.file_url
    expect(normalizeSankakuPost(missing).unavailable).toBe('hidden')
    expect(normalizeSankakuPost(row({ file_url: '', status: 'deleted' })).unavailable).toBe('deleted')
  })

  it('tolerates missing optional fields and rejects rows without an id', () => {
    const post = normalizeSankakuPost({ id: 'abcDEF123', file_url: 'https://v.sankakucomplex.com/data/a.webm?e=1' })
    expect(post).toMatchObject({ fileExt: 'webm', mediaType: 'video', width: null, height: null, md5: null, score: null, createdAt: null, source: null, thumbUrl: null, tags: [] })
    expect(normalizeSankakuPost({ id: '' })).toBeNull()
    expect(normalizeSankakuPost({ id: 'bad/id' })).toBeNull()
  })
})

describe('sankakuAdapter.refresh', () => {
  const stale = normalizeSankakuPost(fixture.keyset.data[1])

  it('fetches the post again uncached and returns the fresh URLs', async () => {
    const fetch = stubFetch(jsonResponse(fixture.post))
    const fresh = await sankakuAdapter.refresh(stale, { fetch })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://sankakuapi.com/posts/YEa7oYL93am')
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(fresh.key).toBe('sankaku:YEa7oYL93am')
    expect(fresh.fileUrl).toBe(fixture.post.file_url)
    expect(fresh.mediaType).toBe('video')
  })

  it('throws unavailable when the fresh copy has no file_url', async () => {
    const hidden = { ...clone(fixture.post), file_url: null, redirect_to_signup: true }
    const error = await sankakuAdapter.refresh(stale, { fetch: stubFetch(jsonResponse(hidden)) }).catch((e) => e)
    expect(error).toBeInstanceOf(RemoteSearchError)
    expect(error).toMatchObject({ kind: 'unavailable', site: 'sankaku', message: HIDDEN_MESSAGE })
  })

  it('throws unavailable for posts the API will not show (404) or ids it rejects (400)', async () => {
    const missing = await sankakuAdapter.refresh(stale, { fetch: stubFetch(jsonResponse({ success: false }, { status: 404 })) }).catch((e) => e)
    expect(missing).toMatchObject({ kind: 'unavailable', status: 404 })
    const invalid = await sankakuAdapter.refresh(stale, { fetch: stubFetch(jsonResponse(fixture.invalidId, { status: 400 })) }).catch((e) => e)
    expect(invalid).toMatchObject({ kind: 'unavailable', status: 400 })
  })

  it('throws upstream when Sankaku returns a different post', async () => {
    const other = { ...clone(fixture.post), id: 'somethingElse' }
    const error = await sankakuAdapter.refresh(stale, { fetch: stubFetch(jsonResponse(other)) }).catch((e) => e)
    expect(error).toMatchObject({ kind: 'upstream' })
  })

  it('keeps a throttle a throttle', async () => {
    const error = await sankakuAdapter.refresh(stale, { fetch: stubFetch(jsonResponse({}, { status: 429, headers: { 'Retry-After': '5' } })) }).catch((e) => e)
    expect(error).toMatchObject({ kind: 'throttled', retryAfterMs: 5000 })
  })
})

describe('sankakuAdapter error mapping', () => {
  it('maps 429 and 503 to throttled, reading Retry-After when exposed', async () => {
    const withHeader = await searchError(stubFetch(jsonResponse({ success: false }, { status: 429, headers: { 'Retry-After': '30' } })))
    expect(withHeader).toBeInstanceOf(RemoteSearchError)
    expect(withHeader).toMatchObject({ kind: 'throttled', status: 429, retryAfterMs: 30000, site: 'sankaku' })
    const without = await searchError(stubFetch(new Response('busy', { status: 503 })))
    expect(without).toMatchObject({ kind: 'throttled', status: 503, retryAfterMs: null })
  })

  it("maps the anonymous tag limit (a 429 in Sankaku's real answer) to a query error", async () => {
    const error = await searchError(stubFetch(jsonResponse(fixture.anonymousTagLimit, { status: 429 })))
    expect(error).toMatchObject({ kind: 'query', status: 429, retryAfterMs: null })
    expect(error.message).toBe('Sankaku allows 4 search terms without an account')
  })

  it('maps other HTTP errors to upstream with the body detail', async () => {
    const error = await searchError(stubFetch(jsonResponse(fixture.invalidId, { status: 400 })))
    expect(error).toMatchObject({ kind: 'upstream', status: 400, message: 'Sankaku answered HTTP 400: invalid id' })
    const html = await searchError(stubFetch(new Response('<html>', { status: 502 })))
    expect(html).toMatchObject({ kind: 'upstream', status: 502, message: 'Sankaku answered HTTP 502' })
  })

  it('maps an unreadable 200 to upstream', async () => {
    const error = await searchError(stubFetch(new Response('not json', { status: 200 })))
    expect(error).toMatchObject({ kind: 'upstream', status: 200 })
  })

  it('maps a fetch TypeError to network and never catches AbortError', async () => {
    const network = await searchError(stubFetch(new TypeError('Failed to fetch')))
    expect(network).toBeInstanceOf(RemoteSearchError)
    expect(network.kind).toBe('network')
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const aborted = await searchError(stubFetch(abort))
    expect(aborted).toBe(abort)
  })

  it('passes the abort signal to fetch', async () => {
    const controller = new AbortController()
    const fetch = stubFetch(jsonResponse(fixture.keyset))
    await sankakuAdapter.search({ query: '', options: ALL, signal: controller.signal, fetch })
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal)
  })
})

describe('sankakuAdapter shape', () => {
  it('is a frozen browser-direct adapter', () => {
    expect(Object.isFrozen(sankakuAdapter)).toBe(true)
    expect(sankakuAdapter).toMatchObject({ id: 'sankaku', label: 'Sankaku', transport: 'browser', pageSize: 20 })
  })
})
