import { describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/safebooru.json'
import { RemoteSearchError } from '../types.js'
import {
  SAFEBOORU_MAX_PAGE,
  decodeEntities,
  normalizeSafebooruPost,
  safebooruAdapter,
  safebooruSafety,
  safebooruUrls,
} from './safebooru.js'

const ALL_SAFETY = { safety: { safe: true, sketchy: true, unsafe: true }, sort: 'date', order: 'desc' }

function relayApi(response = fixture) {
  return { searchSafebooru: vi.fn(async () => structuredClone(response)) }
}

function failingApi(status, detail, message = 'Request failed') {
  const error = Object.assign(new Error(message), { status, detail })
  return { searchSafebooru: vi.fn(async () => { throw error }) }
}

function rows(count) {
  return Array.from({ length: count }, (_, index) => ({ ...fixture.posts[2], id: 1000 + index }))
}

async function searchError(api, args = {}) {
  try {
    await safebooruAdapter.search({ query: 'cat', options: ALL_SAFETY, api, ...args })
  } catch (error) {
    return error
  }
  throw new Error('search did not throw')
}

describe('safebooruAdapter shape', () => {
  it('is a frozen relay adapter with Safebooru\'s own page size', () => {
    expect(Object.isFrozen(safebooruAdapter)).toBe(true)
    expect(safebooruAdapter).toMatchObject({ id: 'safebooru', label: 'Safebooru', transport: 'relay', pageSize: 42 })
  })

  it('translates with the Safebooru tables', () => {
    const result = safebooruAdapter.translate('cat ~dog', { safety: { safe: true, sketchy: false, unsafe: false }, sort: 'id', order: 'asc' })
    expect(result.terms).toEqual(['cat', '-rating:questionable', '-rating:explicit', 'sort:id:asc'])
    expect(result.ignored).toEqual(['~dog'])
  })
})

describe('safebooruAdapter.search', () => {
  it('calls the relay with { tags, page, limit } and the signal', async () => {
    const api = relayApi()
    const signal = new AbortController().signal
    await safebooruAdapter.search({ query: 'cat_ears -dog', options: { safety: { safe: true, sketchy: true, unsafe: false } }, cursor: null, signal, api })
    expect(api.searchSafebooru).toHaveBeenCalledWith({ tags: 'cat_ears -dog -rating:explicit', page: 1, limit: 42 }, signal)
  })

  it('passes the cursor page and the per-page choice capped at 100', async () => {
    const api = relayApi()
    await safebooruAdapter.search({ query: '', options: ALL_SAFETY, cursor: { page: 3 }, api, limit: 500 })
    expect(api.searchSafebooru.mock.calls[0][0]).toEqual({ tags: '', page: 3, limit: 100 })
    await safebooruAdapter.search({ query: '', options: ALL_SAFETY, api, limit: 'default' })
    expect(api.searchSafebooru.mock.calls[1][0].limit).toBe(42)
  })

  it('normalises the fixture rows', async () => {
    const result = await safebooruAdapter.search({ query: 'miyu_(blue_archive)', options: ALL_SAFETY, api: relayApi() })
    expect(result.total).toBeNull()
    expect(result.posts.map((post) => post.key)).toEqual(['safebooru:7224325', 'safebooru:7226099', 'safebooru:19999'])
    expect(result.posts[0]).toMatchObject({
      site: 'safebooru',
      id: '7224325',
      postUrl: 'https://safebooru.org/index.php?page=post&s=view&id=7224325',
      thumbUrl: 'https://safebooru.org/thumbnails/3923/thumbnail_c998daee4db136c84bc5e19920c3da1fdbd915a3.jpg',
      sampleUrl: 'https://safebooru.org/samples/3923/sample_c998daee4db136c84bc5e19920c3da1fdbd915a3.jpg',
      fileUrl: 'https://safebooru.org/images/3923/c998daee4db136c84bc5e19920c3da1fdbd915a3.jpg',
      width: 1434,
      height: 2000,
      fileExt: 'jpg',
      mediaType: 'image',
      fileSize: null,
      safety: 'safe',
      rawRating: 'general',
      source: 'https://x.com/ideolo/status/2109195087641260325',
      md5: '7e3b807fca194fc77164c282852248af',
      score: null,
      createdAt: new Date(1791745204 * 1000).toISOString(),
      unavailable: null,
      referer: 'https://safebooru.org/',
    })
    expect(result.posts[2]).toMatchObject({ fileExt: 'png', mediaType: 'image', rawRating: 'safe', safety: 'safe', score: 0, source: null })
  })

  it('decodes, flattens and dedupes tags, all general, with display names', async () => {
    const [post] = (await safebooruAdapter.search({ options: ALL_SAFETY, api: relayApi() })).posts
    // '>_<' flattens to nothing and is dropped.
    expect(post.tags.slice(0, 4)).toEqual(['0_0', '6_girls', 'ahoge', 'angel_s_24_uniform_blue_archive'])
    expect(post.tags).toContain('miyu_blue_archive')
    expect(post.tags).toContain('jack-o_-lantern')
    expect(post.tags).not.toContain('safebooru_7224325')
    expect(post.tags.every((tag) => tag && !/[&;()]/.test(tag))).toBe(true)
    expect(new Set(Object.values(post.tagCategories))).toEqual(new Set(['general']))
    expect(Object.keys(post.tagCategories)).toEqual(post.tags)
    expect(post.tagDisplayNames).toMatchObject({
      angel_s_24_uniform_blue_archive: "angel's 24 uniform (blue archive)",
      miyu_blue_archive: 'miyu (blue archive)',
      yuzu_armed_blue_archive: 'yuzu (armed) (blue archive)',
      '6_girls': '6+girls',
    })
    expect(post.tagDisplayNames).not.toHaveProperty('ahoge')

    const deduped = normalizeSafebooruPost({ ...fixture.posts[2], tags: 'Cat cat  cat_(animal) cat_animal' })
    expect(deduped.tags).toEqual(['cat', 'cat_animal'])
  })

  it('keeps a gif without a sample: no sampleUrl, mediaType gif', async () => {
    const post = (await safebooruAdapter.search({ options: ALL_SAFETY, api: relayApi() })).posts[1]
    expect(post).toMatchObject({
      fileUrl: 'https://safebooru.org/images/3923/fb331f097d60d2c596fc2b5ea1d0abc45065fb5f.gif',
      sampleUrl: null,
      thumbUrl: 'https://safebooru.org/thumbnails/3923/thumbnail_fb331f097d60d2c596fc2b5ea1d0abc45065fb5f.jpg',
      fileExt: 'gif',
      mediaType: 'gif',
    })
  })

  it('treats a short page as exhausted and a full page as having more', async () => {
    const short = await safebooruAdapter.search({ options: ALL_SAFETY, api: relayApi() })
    expect(short.nextCursor).toBeNull()

    const full = await safebooruAdapter.search({ options: ALL_SAFETY, cursor: { page: 2 }, api: relayApi({ ...fixture, page: 2, posts: rows(42) }) })
    expect(full.posts).toHaveLength(42)
    expect(full.nextCursor).toEqual({ page: 3 })

    const custom = await safebooruAdapter.search({ options: ALL_SAFETY, limit: 5, api: relayApi({ ...fixture, limit: 5, posts: rows(5) }) })
    expect(custom.nextCursor).toEqual({ page: 2 })

    const capped = await safebooruAdapter.search({ options: ALL_SAFETY, cursor: { page: SAFEBOORU_MAX_PAGE }, api: relayApi({ ...fixture, posts: rows(42) }) })
    expect(capped.nextCursor).toBeNull()
  })

  it('treats an empty or non-array relay body as an exhausted empty page', async () => {
    for (const response of [{ ...fixture, posts: [] }, { ...fixture, posts: null }, { ...fixture, posts: {} }, null]) {
      const result = await safebooruAdapter.search({ options: ALL_SAFETY, api: relayApi(response) })
      expect(result).toMatchObject({ posts: [], nextCursor: null, total: null })
    }
  })

  it('reports ignored terms and the translation note', async () => {
    const result = await safebooruAdapter.search({ query: 'cat fav:me', options: { ...ALL_SAFETY, sort: 'size' }, api: relayApi() })
    expect(result.ignoredTerms).toEqual(expect.arrayContaining(['fav:me']))
    expect(result.ignoredTerms.length).toBe(2)
    expect(result.note).toBeNull()
  })

  it('skips rows without a usable id', async () => {
    const result = await safebooruAdapter.search({ options: ALL_SAFETY, api: relayApi({ ...fixture, posts: [{ id: 0 }, null, fixture.posts[2]] }) })
    expect(result.posts.map((post) => post.id)).toEqual(['19999'])
  })
})

describe('rating mapping', () => {
  it.each([
    ['general', 'safe'], ['safe', 'safe'], ['g', 'safe'], ['s', 'safe'],
    ['sensitive', 'sketchy'], ['questionable', 'sketchy'], ['q', 'sketchy'],
    ['explicit', 'unsafe'], ['e', 'unsafe'], ['Explicit', 'unsafe'],
    ['', 'safe'], [undefined, 'safe'],
  ])('%s -> %s', (rating, safety) => {
    expect(safebooruSafety(rating)).toBe(safety)
    expect(normalizeSafebooruPost({ ...fixture.posts[0], rating }).safety).toBe(safety)
  })
})

describe('URL building', () => {
  const bare = { id: 5, directory: 3923, image: 'abc123.png', sample: true, tags: 'cat' }

  it('builds file, sample and preview from directory + image when the URLs are missing', () => {
    expect(safebooruUrls(bare)).toEqual({
      fileUrl: 'https://safebooru.org/images/3923/abc123.png',
      sampleUrl: 'https://safebooru.org/samples/3923/sample_abc123.jpg',
      thumbUrl: 'https://safebooru.org/thumbnails/3923/thumbnail_abc123.jpg',
    })
    expect(safebooruUrls({ ...bare, sample: false }).sampleUrl).toBeNull()
  })

  it('matches what the live rows carry', () => {
    for (const row of fixture.posts) {
      const built = safebooruUrls({ ...row, file_url: '', sample_url: '', preview_url: '' })
      expect(built).toEqual(safebooruUrls(row))
    }
  })

  it('resolves protocol- and root-relative URLs, rejects non-https ones', () => {
    expect(safebooruUrls({ file_url: '//safebooru.org/images/1/a.jpg' }).fileUrl).toBe('https://safebooru.org/images/1/a.jpg')
    expect(safebooruUrls({ preview_url: '/thumbnails/1/thumbnail_a.jpg' }).thumbUrl).toBe('https://safebooru.org/thumbnails/1/thumbnail_a.jpg')
    expect(safebooruUrls({ file_url: 'javascript:alert(1)' }).fileUrl).toBeNull()
  })

  it('marks a row with no file as unavailable', () => {
    const post = normalizeSafebooruPost({ id: 9, tags: 'cat', rating: 'general' })
    expect(post).toMatchObject({ fileUrl: null, thumbUrl: null, fileExt: '', mediaType: 'unknown', unavailable: 'no-file' })
    expect(normalizeSafebooruPost({ id: 9, status: 'deleted' }).unavailable).toBe('deleted')
  })

  it('decodes HTML entities in sources', () => {
    expect(decodeEntities('a?x=1&amp;y=&#x32;&#039;&bogus;')).toBe("a?x=1&y=2'&bogus;")
    expect(normalizeSafebooruPost({ ...fixture.posts[0], source: 'https://e.com/?a=1&amp;b=2' }).source).toBe('https://e.com/?a=1&b=2')
  })
})

describe('error mapping', () => {
  it('maps the relay 429 to throttled with retryAfter', async () => {
    const error = await searchError(failingApi(429, { code: 'upstream_throttled', message: 'Safebooru is rate limiting', retryAfter: 30 }))
    expect(error).toBeInstanceOf(RemoteSearchError)
    expect(error).toMatchObject({ site: 'safebooru', status: 429, kind: 'throttled', retryAfterMs: 30000, message: 'Safebooru is rate limiting' })
    const bare = await searchError(failingApi(429, { code: 'upstream_throttled', message: 'slow down' }))
    expect(bare.retryAfterMs).toBeNull()
  })

  it.each([
    [502, { code: 'upstream_error', message: 'Safebooru answered HTTP 500' }, 'upstream'],
    [403, { code: 'booru_search_disabled', message: 'Booru search is disabled' }, 'disabled'],
    [403, 'Admin only', 'upstream'],
    [400, 'tags too long', 'query'],
    [500, 'Internal Server Error', 'upstream'],
  ])('maps HTTP %i to the right kind', async (status, detail, kind) => {
    const error = await searchError(failingApi(status, detail))
    expect(error).toMatchObject({ status, kind })
  })

  it('maps an unreachable backend to network', async () => {
    const api = { searchSafebooru: vi.fn(async () => { throw new Error('Backend server is not running.') }) }
    expect(await searchError(api)).toMatchObject({ kind: 'network', status: null })
  })

  it('never wraps an AbortError', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const api = { searchSafebooru: vi.fn(async () => { throw abort }) }
    expect(await searchError(api)).toBe(abort)
  })
})

describe('safebooruAdapter.refresh', () => {
  it('returns the post unchanged (Safebooru URLs are stable)', async () => {
    const post = normalizeSafebooruPost(fixture.posts[0])
    const api = relayApi()
    await expect(safebooruAdapter.refresh(post, { api })).resolves.toBe(post)
    expect(api.searchSafebooru).not.toHaveBeenCalled()
  })

  it('throws unavailable for a post without an original', async () => {
    const post = normalizeSafebooruPost({ id: 9, tags: 'cat' })
    await expect(safebooruAdapter.refresh(post, {})).rejects.toMatchObject({ kind: 'unavailable', site: 'safebooru' })
  })
})
