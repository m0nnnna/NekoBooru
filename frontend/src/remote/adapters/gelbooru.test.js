import { describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/gelbooru.json'
import { ApiError } from '../../api/request.js'
import { RemoteSearchError } from '../types.js'
import { gelbooruAdapter, normalizeGelbooruPost } from './gelbooru.js'

const ALL_RATINGS = { safety: { safe: true, sketchy: true, unsafe: true }, sort: 'date', order: 'desc' }
const [imageRow, mp4Row, webmRow, gifRow, noFileRow] = fixture.page.posts

function fakeApi(response = fixture.page) {
  return { searchGelbooru: vi.fn(async () => structuredClone(response)) }
}

function failingApi(status, detail, message = 'Request failed') {
  const retryAfter = detail && typeof detail === 'object' ? detail.retryAfter : null
  const error = new ApiError(message, { kind: 'http', status, detail, retryAfterMs: retryAfter ? retryAfter * 1000 : null })
  return { searchGelbooru: vi.fn(async () => { throw error }) }
}

function search(args = {}) {
  return gelbooruAdapter.search({ query: '', options: ALL_RATINGS, cursor: null, signal: undefined, api: fakeApi(), ...args })
}

describe('gelbooruAdapter shape', () => {
  it('is a frozen relay adapter with Gelbooru\'s own page size', () => {
    expect(Object.isFrozen(gelbooruAdapter)).toBe(true)
    expect(gelbooruAdapter).toMatchObject({ id: 'gelbooru', label: 'Gelbooru', transport: 'relay', pageSize: 42 })
  })

  it('translate() is the Gelbooru query translation', () => {
    const result = gelbooruAdapter.translate('cat ~dog', { safety: { safe: true, sketchy: false, unsafe: false }, sort: 'id', order: 'asc' })
    expect(result.terms).toEqual(['cat', '-rating:sensitive', '-rating:questionable', '-rating:explicit', 'sort:id:asc'])
    expect(result.ignored).toEqual(['~dog'])
  })
})

describe('search request', () => {
  it('sends the translated tags, a 1-based page and the default limit to the relay', async () => {
    const api = fakeApi()
    const signal = new AbortController().signal
    const result = await gelbooruAdapter.search({
      query: 'cat ~dog fav:me', options: { safety: { safe: true, sketchy: true, unsafe: false }, sort: 'size', order: 'desc' },
      cursor: null, signal, api,
    })
    expect(api.searchGelbooru).toHaveBeenCalledTimes(1)
    expect(api.searchGelbooru).toHaveBeenCalledWith({ tags: 'cat -rating:explicit', page: 1, limit: 42 }, signal)
    expect(result.ignoredTerms).toEqual(['~dog', 'fav:me', 'size sorting'])
    expect(result.note).toBeNull()
  })

  it('follows the cursor page and the per-page choice, capped at Gelbooru\'s max', async () => {
    const api = fakeApi()
    await gelbooruAdapter.search({ query: 'cat', options: ALL_RATINGS, cursor: { page: 3 }, api, limit: 500 })
    await gelbooruAdapter.search({ query: 'cat', options: ALL_RATINGS, cursor: { page: 2 }, api, limit: 'default' })
    await gelbooruAdapter.search({ query: 'cat', options: ALL_RATINGS, cursor: { page: 'junk' }, api, limit: 20 })
    expect(api.searchGelbooru.mock.calls.map(([params]) => params)).toEqual([
      { tags: 'cat', page: 3, limit: 100 },
      { tags: 'cat', page: 2, limit: 42 },
      { tags: 'cat', page: 1, limit: 20 },
    ])
  })
})

describe('total and paging', () => {
  it('a page shorter than the limit is the last one', async () => {
    const result = await search()
    expect(result.posts).toHaveLength(5)
    expect(result.total).toBe(1234)
    expect(result.totalIsEstimate).toBe(false)
    expect(result.nextCursor).toBeNull()
  })

  it('a full page with more posts left offers the next page', async () => {
    const result = await search({ limit: 5 })
    expect(result.nextCursor).toEqual({ page: 2 })
    const later = await search({ limit: 5, cursor: { page: 7 } })
    expect(later.nextCursor).toEqual({ page: 8 })
  })

  it('stops when the total says everything was fetched', async () => {
    const api = fakeApi({ ...fixture.page, total: 10 })
    expect((await search({ api, limit: 5, cursor: { page: 2 } })).nextCursor).toBeNull()
    expect((await search({ api, limit: 5, cursor: { page: 1 } })).nextCursor).toEqual({ page: 2 })
  })

  it('keeps paging on full pages when the total is unknown', async () => {
    const result = await search({ api: fakeApi({ ...fixture.page, total: null }), limit: 5 })
    expect(result.total).toBeNull()
    expect(result.nextCursor).toEqual({ page: 2 })
  })

  it('stops at the relay\'s last page and Gelbooru\'s 20000 offset cap', async () => {
    const full = (count) => fakeApi({ ...fixture.page, total: null, posts: Array.from({ length: count }, (_, i) => ({ ...imageRow, id: i + 1 })) })
    expect((await search({ api: full(1), limit: 1, cursor: { page: 499 } })).nextCursor).toEqual({ page: 500 })
    expect((await search({ api: full(1), limit: 1, cursor: { page: 500 } })).nextCursor).toBeNull()
    expect((await search({ api: full(100), limit: 100, cursor: { page: 199 } })).nextCursor).toEqual({ page: 200 })
    expect((await search({ api: full(100), limit: 100, cursor: { page: 200 } })).nextCursor).toBeNull()
  })

  it('an empty result is exhausted, and a missing or single-object posts field is tolerated', async () => {
    expect(await search({ api: fakeApi(fixture.empty) })).toMatchObject({ posts: [], nextCursor: null, total: 0 })
    expect(await search({ api: fakeApi({ site: 'gelbooru', page: 1, limit: 42 }) })).toMatchObject({ posts: [], nextCursor: null, total: null })
    const single = await search({ api: fakeApi({ ...fixture.page, posts: gifRow }) })
    expect(single.posts.map((post) => post.id)).toEqual(['10234400'])
  })
})

describe('normalized posts', () => {
  it('maps an image row with a sample', () => {
    expect(normalizeGelbooruPost(imageRow)).toEqual({
      key: 'gelbooru:10234567',
      site: 'gelbooru',
      id: '10234567',
      postUrl: 'https://gelbooru.com/index.php?page=post&s=view&id=10234567',
      thumbUrl: 'https://img3.gelbooru.com/thumbnails/3f/2a/thumbnail_3f2a9c0d8e7b6a5f4e3d2c1b0a998877.jpg',
      sampleUrl: 'https://img3.gelbooru.com/samples/3f/2a/sample_3f2a9c0d8e7b6a5f4e3d2c1b0a998877.jpg',
      fileUrl: 'https://img3.gelbooru.com/images/3f/2a/3f2a9c0d8e7b6a5f4e3d2c1b0a998877.png',
      width: 2480,
      height: 3508,
      fileExt: 'png',
      mediaType: 'image',
      fileSize: null,
      safety: 'safe',
      rawRating: 'general',
      tags: ['1girl', 'animal_ears', 'blue_archive', 'halo', 'miyu_blue_archive', 'rabbit_ears', 'solo'],
      tagCategories: {
        '1girl': 'general', animal_ears: 'general', blue_archive: 'general', halo: 'general',
        miyu_blue_archive: 'general', rabbit_ears: 'general', solo: 'general',
      },
      tagDisplayNames: { miyu_blue_archive: 'miyu (blue archive)' },
      source: 'https://www.pixiv.net/artworks/123456789',
      md5: '3f2a9c0d8e7b6a5f4e3d2c1b0a998877',
      score: 12,
      createdAt: '2026-10-13T02:15:04.000Z',
      unavailable: null,
      referer: 'https://gelbooru.com/',
    })
  })

  it('maps video rows: preview thumbnail, original file, no sample', () => {
    const mp4 = normalizeGelbooruPost(mp4Row)
    expect(mp4).toMatchObject({
      fileExt: 'mp4', mediaType: 'video', sampleUrl: null, source: null,
      thumbUrl: 'https://img3.gelbooru.com/thumbnails/a1/b2/thumbnail_a1b2c3d4e5f60718293a4b5c6d7e8f90.jpg',
      fileUrl: 'https://video-cdn3.gelbooru.com/images/a1/b2/a1b2c3d4e5f60718293a4b5c6d7e8f90.mp4',
    })
    expect(normalizeGelbooruPost(webmRow)).toMatchObject({ fileExt: 'webm', mediaType: 'video', sampleUrl: null })
    expect(normalizeGelbooruPost({ ...webmRow, image: '' })).toMatchObject({ fileExt: 'webm', mediaType: 'video' })
    expect(normalizeGelbooruPost({ ...webmRow, sample_url: 'https://img3.gelbooru.com/samples/x.jpg' }).sampleUrl).toBeNull()
    expect(normalizeGelbooruPost(gifRow)).toMatchObject({ fileExt: 'gif', mediaType: 'gif', createdAt: '2026-10-10T14:59:59.000Z' })
  })

  it('decodes HTML entities, dedupes tags and keeps every tag general', () => {
    const post = normalizeGelbooruPost(mp4Row)
    expect(post.tags).toEqual(['2girls', 'animated', 'girls_frontline', 'm4a1_girls_frontline', 'sound', 'video'])
    expect(new Set(Object.values(post.tagCategories))).toEqual(new Set(['general']))
    expect(Object.keys(post.tagCategories)).toEqual(post.tags)
    expect(post.tagDisplayNames).toEqual({ girls_frontline: "girls' frontline", m4a1_girls_frontline: "m4a1 (girls' frontline)" })
    expect(post.tags).not.toContain('gelbooru_10234501')

    const escaped = normalizeGelbooruPost({
      ...imageRow,
      tags: '&gt;_&lt; rock&amp;roll angel&#39;s_wings &quot;quoted&quot; caf&#xe9;',
      source: 'https://example.com/?a=1&amp;b=2',
    })
    expect(escaped.tags).toEqual(['rock_roll', 'angel_s_wings', 'quoted', 'café'])
    expect(escaped.tagDisplayNames).toEqual({ rock_roll: 'rock&roll', angel_s_wings: "angel's wings", quoted: '"quoted"' })
    expect(escaped.source).toBe('https://example.com/?a=1&b=2')
  })

  it.each([
    ['general', 'safe'], ['g', 'safe'], ['safe', 'safe'], ['', 'safe'],
    ['sensitive', 'sketchy'], ['s', 'sketchy'], ['questionable', 'sketchy'], ['q', 'sketchy'],
    ['explicit', 'unsafe'], ['e', 'unsafe'], ['Explicit', 'unsafe'],
  ])('rating %j -> %s', (rating, safety) => {
    const post = normalizeGelbooruPost({ ...imageRow, rating })
    expect(post.safety).toBe(safety)
    expect(post.rawRating).toBe(rating.toLowerCase())
  })

  it('a row without an original is unavailable but keeps its thumbnail', () => {
    expect(normalizeGelbooruPost(noFileRow)).toMatchObject({
      fileUrl: null, unavailable: 'no-file', fileExt: 'jpg', mediaType: 'image',
      thumbUrl: 'https://img3.gelbooru.com/thumbnails/00/11/thumbnail_00112233445566778899aabbccddeeff.jpg',
    })
    expect(normalizeGelbooruPost({ ...noFileRow, file_url: undefined, status: 'deleted' }).unavailable).toBe('deleted')
    expect(normalizeGelbooruPost({ ...imageRow, file_url: 'javascript:alert(1)' })).toMatchObject({ fileUrl: null, unavailable: 'no-file' })
    expect(normalizeGelbooruPost({ ...imageRow, preview_url: '' }).thumbUrl).toBeNull()
  })

  it('tolerates odd fields and skips rows without an id', () => {
    const odd = normalizeGelbooruPost({ id: '42', file_url: '//img3.gelbooru.com/images/x.JPEG', created_at: 'not a date', md5: 'nope', score: null })
    expect(odd).toMatchObject({
      id: '42', fileUrl: 'https://img3.gelbooru.com/images/x.JPEG', fileExt: 'jpeg', mediaType: 'image',
      width: null, height: null, createdAt: null, md5: null, score: null, tags: [], rawRating: '', safety: 'safe',
    })
    expect(normalizeGelbooruPost({ ...imageRow, id: 0 })).toBeNull()
    expect(normalizeGelbooruPost(null)).toBeNull()
  })

  it('search drops rows without an id and never keeps the raw row', async () => {
    const result = await search({ api: fakeApi({ ...fixture.page, posts: [{ tags: 'cat' }, imageRow] }) })
    expect(result.posts.map((post) => post.key)).toEqual(['gelbooru:10234567'])
    expect(result.posts[0]).toEqual(normalizeGelbooruPost(imageRow))
    expect(result.posts[0]).not.toHaveProperty('preview_url')
  })
})

describe('relay errors', () => {
  async function caught(api) {
    try {
      await search({ api })
    } catch (error) {
      return error
    }
    throw new Error('search did not throw')
  }

  it('throttled: 429 with retryAfter from the relay detail', async () => {
    const error = await caught(failingApi(429, { code: 'upstream_throttled', message: 'Gelbooru is rate limiting', retryAfter: 30 }, 'Gelbooru is rate limiting'))
    expect(error).toBeInstanceOf(RemoteSearchError)
    expect(error).toMatchObject({ site: 'gelbooru', kind: 'throttled', status: 429, retryAfterMs: 30_000, message: 'Gelbooru is rate limiting' })
    expect(await caught(failingApi(429, { code: 'upstream_throttled' }))).toMatchObject({ kind: 'throttled', retryAfterMs: null })
    expect(await caught(failingApi(503, 'Service Unavailable'))).toMatchObject({ kind: 'throttled', status: 503 })
  })

  it('credentials, disabled, bad parameters, upstream and network', async () => {
    const credentials = await caught(failingApi(400, { code: 'gelbooru_credentials_missing', message: 'Gelbooru rejected the saved API credentials' }, 'Gelbooru rejected the saved API credentials'))
    expect(credentials).toMatchObject({ kind: 'credentials', status: 400, message: 'Gelbooru rejected the saved API credentials' })
    expect(await caught(failingApi(403, { code: 'booru_search_disabled', message: 'Booru search is disabled' }))).toMatchObject({ kind: 'disabled', status: 403 })
    expect(await caught(failingApi(400, 'page must be between 1 and 500'))).toMatchObject({ kind: 'query', status: 400 })
    expect(await caught(failingApi(502, { code: 'upstream_error', message: 'Gelbooru returned HTTP 500' }))).toMatchObject({ kind: 'upstream', status: 502 })
    expect(await caught(failingApi(403, 'Admin only'))).toMatchObject({ kind: 'upstream', status: 403 })
    const offline = await caught({ searchGelbooru: vi.fn(async () => { throw new ApiError('Backend server is not running.', { kind: 'network' }) }) })
    expect(offline).toMatchObject({ kind: 'network', status: null })
  })

  it('lets an abort through untouched', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const error = await caught({ searchGelbooru: vi.fn(async () => { throw abort }) })
    expect(error).toBe(abort)
  })
})

describe('refresh', () => {
  it('returns the post unchanged without a request (Gelbooru URLs are stable)', async () => {
    const api = fakeApi()
    const post = normalizeGelbooruPost(imageRow)
    expect(await gelbooruAdapter.refresh(post, { signal: undefined, api })).toBe(post)
    expect(api.searchGelbooru).not.toHaveBeenCalled()
  })

  it('throws unavailable when there is no original', async () => {
    const post = normalizeGelbooruPost(noFileRow)
    await expect(gelbooruAdapter.refresh(post, { api: fakeApi() })).rejects.toMatchObject({ name: 'RemoteSearchError', site: 'gelbooru', kind: 'unavailable' })
  })
})
