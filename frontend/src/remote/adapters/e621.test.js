import { describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/e621.json'
import { RemoteSearchError } from '../types.js'
import { E621_PAGE_CAP, e621Adapter, normalizeE621Post } from './e621.js'

// fixtures/e621.json is a trimmed real e926 response: a jpg, a webm and a
// deleted post whose URLs are all null.
const [imageRow, videoRow, deletedRow] = fixture.posts
const clone = (value) => JSON.parse(JSON.stringify(value))
const ALL_RATINGS = { safety: { safe: true, sketchy: true, unsafe: true }, sort: 'date', order: 'desc' }

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

function requestedUrl(fetchStub, call = 0) {
  return new URL(fetchStub.mock.calls[call][0])
}

describe('e621Adapter.search', () => {
  it('requests posts.json with tags, page, the default limit and _client', async () => {
    const fetch = stubFetch(jsonResponse(fixture))
    const signal = new AbortController().signal
    await e621Adapter.search({ query: 'landscape -human', options: ALL_RATINGS, cursor: null, signal, fetch })

    const url = requestedUrl(fetch)
    expect(`${url.origin}${url.pathname}`).toBe('https://e621.net/posts.json')
    expect(Object.fromEntries(url.searchParams)).toEqual({ tags: 'landscape -human', page: '1', limit: '75', _client: 'NekoBooru/1.0' })
    expect(fetch.mock.calls[0][1]).toEqual({
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    })
  })

  it('translates ratings and sort into e621 terms and reports ignored ones', async () => {
    const fetch = stubFetch(jsonResponse(fixture))
    const options = { safety: { safe: true, sketchy: false, unsafe: false }, sort: 'size', order: 'desc' }
    const result = await e621Adapter.search({ query: 'fox pool:3', options, fetch })

    expect(requestedUrl(fetch).searchParams.get('tags')).toBe('fox -rating:q -rating:e order:filesize')
    expect(result.ignoredTerms).toEqual(['pool:3'])
    expect(result.note).toBeNull()
    expect(e621Adapter.translate('fox pool:3', options).ignored).toEqual(['pool:3'])
  })

  it('normalizes an image post', async () => {
    const { posts, total } = await e621Adapter.search({ query: '', options: ALL_RATINGS, fetch: stubFetch(jsonResponse(fixture)) })
    expect(total).toBeNull()
    expect(posts).toHaveLength(3)
    expect(posts[0]).toMatchObject({
      key: 'e621:360224',
      site: 'e621',
      id: '360224',
      postUrl: 'https://e621.net/posts/360224',
      thumbUrl: 'https://static1.e926.net/data/preview/3c/46/3c4619ee5164c6c9e9767db9fae4f73e.jpg',
      sampleUrl: null, // sample.has is false
      fileUrl: 'https://static1.e926.net/data/3c/46/3c4619ee5164c6c9e9767db9fae4f73e.jpg',
      width: 763,
      height: 1080,
      fileExt: 'jpg',
      mediaType: 'image',
      fileSize: 470678,
      safety: 'safe',
      rawRating: 's',
      source: 'https://furrynetwork.com/artwork/31383',
      md5: '3c4619ee5164c6c9e9767db9fae4f73e',
      score: 1026,
      createdAt: '2013-08-03T15:40:30.777Z',
      unavailable: null,
      referer: 'https://e621.net/',
    })
    expect(posts[0]).not.toHaveProperty('tags.general')
    expect(posts[0]).not.toHaveProperty('file')
  })

  it('maps every e621 tag group onto NekoBooru categories', async () => {
    const { posts } = await e621Adapter.search({ query: '', options: ALL_RATINGS, fetch: stubFetch(jsonResponse(fixture)) })
    const [image] = posts
    expect(image.tagCategories).toMatchObject({
      feretta: 'artist',
      tale_of_tails: 'copyright',
      unknown_species: 'general', // species -> general
      landscape: 'general',
      'bird_s-eye_view': 'general',
      digital_media_artwork: 'meta',
      english_text: 'meta',
    })
    expect(image.tags).not.toContain('e621_360224')
    expect(Object.keys(image.tagCategories).sort()).toEqual([...image.tags].sort())
    expect(new Set(image.tags).size).toBe(image.tags.length)
    expect(image.tagDisplayNames).toEqual({
      'bird_s-eye_view': "bird's-eye view",
      digital_media_artwork: 'digital media (artwork)',
    })

    const row = clone(imageRow)
    row.tags = {
      general: ['Solo', 'solo'],
      artist: ['some_artist'],
      contributor: ['some_contributor'],
      copyright: ['some_series'],
      character: ['hero_(some_series)'],
      species: ['red_fox'],
      invalid: ['typo_tag'],
      meta: ['hi_res'],
      lore: ['female_(lore)'],
    }
    const post = normalizeE621Post(row)
    expect(post.tagCategories).toEqual({
      some_artist: 'artist',
      some_contributor: 'artist', // contributor -> artist
      some_series: 'copyright',
      hero_some_series: 'character',
      red_fox: 'general',
      solo: 'general',
      female_lore: 'meta', // lore -> meta
      hi_res: 'meta',
    })
    expect(post.tags).not.toContain('typo_tag') // invalid is dropped
    expect(post.tagDisplayNames).toEqual({ hero_some_series: 'hero (some series)', female_lore: 'female (lore)' })
  })

  it('normalizes a webm post as video with its sample', async () => {
    const { posts } = await e621Adapter.search({ query: '', options: ALL_RATINGS, fetch: stubFetch(jsonResponse(fixture)) })
    expect(posts[1]).toMatchObject({
      key: 'e621:6336267',
      fileExt: 'webm',
      mediaType: 'video',
      width: 3840,
      height: 2160,
      sampleUrl: 'https://static1.e926.net/data/sample/8e/bb/8ebb075318fb803fefe547fa2ffaa214.jpg',
      fileUrl: 'https://static1.e926.net/data/8e/bb/8ebb075318fb803fefe547fa2ffaa214.webm',
      source: videoRow.sources[0],
      tagCategories: expect.objectContaining({ kertit: 'artist', crossout_game: 'copyright', spotted_hyena: 'general', animated: 'meta' }),
    })
  })

  it('marks posts with null URLs unavailable', async () => {
    const { posts } = await e621Adapter.search({ query: '', options: ALL_RATINGS, fetch: stubFetch(jsonResponse(fixture)) })
    expect(posts[2]).toMatchObject({
      key: 'e621:6775146',
      thumbUrl: null,
      sampleUrl: null,
      fileUrl: null,
      fileExt: 'webp',
      mediaType: 'image',
      width: 1050,
      unavailable: 'deleted',
    })

    const hidden = clone(deletedRow)
    hidden.flags.deleted = false // the anonymous blacklist hides posts the same way
    expect(normalizeE621Post(hidden).unavailable).toBe('hidden')
  })

  it('maps each e621 rating to a safety', () => {
    const rated = (rating) => normalizeE621Post({ ...clone(imageRow), rating })
    expect(rated('s')).toMatchObject({ safety: 'safe', rawRating: 's' })
    expect(rated('q')).toMatchObject({ safety: 'sketchy', rawRating: 'q' })
    expect(rated('E')).toMatchObject({ safety: 'unsafe', rawRating: 'e' })
    expect(rated('x').safety).toBe('unsafe')
  })

  it('takes the first non-empty source, or null', () => {
    expect(normalizeE621Post({ ...clone(imageRow), sources: ['', ' https://a.example/1 '] }).source).toBe('https://a.example/1')
    expect(normalizeE621Post({ ...clone(imageRow), sources: [] }).source).toBeNull()
  })

  it('pages with { page } cursors while full pages come back', async () => {
    const fullPage = { posts: Array.from({ length: 3 }, (_, index) => ({ ...clone(imageRow), id: 100 + index })) }
    const fetch = stubFetch(jsonResponse(fullPage), jsonResponse(fixture), jsonResponse({ posts: [] }))

    const first = await e621Adapter.search({ query: 'fox', options: ALL_RATINGS, cursor: null, limit: 3, fetch })
    expect(first.nextCursor).toEqual({ page: 2 })
    expect(requestedUrl(fetch, 0).searchParams.get('limit')).toBe('3')

    const second = await e621Adapter.search({ query: 'fox', options: ALL_RATINGS, cursor: first.nextCursor, limit: 5, fetch })
    expect(requestedUrl(fetch, 1).searchParams.get('page')).toBe('2')
    expect(second.nextCursor).toBeNull() // 3 posts < limit 5

    const empty = await e621Adapter.search({ query: 'fox', options: ALL_RATINGS, cursor: { page: 3 }, fetch })
    expect(empty).toMatchObject({ posts: [], nextCursor: null })
  })

  it('caps the limit at 320 and stops at page 750', async () => {
    const fetch = stubFetch(jsonResponse(fixture), jsonResponse(fixture))
    await e621Adapter.search({ query: '', options: ALL_RATINGS, limit: 1000, fetch })
    expect(requestedUrl(fetch, 0).searchParams.get('limit')).toBe('320')

    const last = await e621Adapter.search({ query: '', options: ALL_RATINGS, cursor: { page: E621_PAGE_CAP }, limit: 3, fetch })
    expect(last.posts).toHaveLength(3)
    expect(last.nextCursor).toBeNull()
  })
})

describe('e621Adapter errors', () => {
  async function searchError(fetch) {
    try {
      await e621Adapter.search({ query: 'fox', options: ALL_RATINGS, fetch })
    } catch (error) {
      return error
    }
    throw new Error('search did not throw')
  }

  it('maps 429 to throttled with Retry-After', async () => {
    const error = await searchError(stubFetch(jsonResponse({ success: false }, { status: 429, headers: { 'Retry-After': '12' } })))
    expect(error).toBeInstanceOf(RemoteSearchError)
    expect(error).toMatchObject({ site: 'e621', status: 429, kind: 'throttled', retryAfterMs: 12000 })
  })

  it('maps 503 without Retry-After to throttled with no delay', async () => {
    const error = await searchError(stubFetch(new Response('busy', { status: 503 })))
    expect(error).toMatchObject({ status: 503, kind: 'throttled', retryAfterMs: null })
  })

  it('maps 422 to a query error carrying e621\'s message', async () => {
    const body = { success: false, message: 'You cannot search for more than 40 tags at a time', code: null }
    const error = await searchError(stubFetch(jsonResponse(body, { status: 422 })))
    expect(error).toMatchObject({ status: 422, kind: 'query', message: body.message })
  })

  it('maps other HTTP errors to upstream', async () => {
    const error = await searchError(stubFetch(new Response('<html>challenge</html>', { status: 403 })))
    expect(error).toMatchObject({ status: 403, kind: 'upstream' })
  })

  it('maps a non-JSON 200 to upstream', async () => {
    const error = await searchError(stubFetch(new Response('<html></html>', { status: 200 })))
    expect(error).toMatchObject({ status: 200, kind: 'upstream' })
  })

  it('maps fetch failures to network and lets aborts through', async () => {
    const error = await searchError(stubFetch(new TypeError('Failed to fetch')))
    expect(error).toMatchObject({ kind: 'network', status: null })

    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const aborted = await searchError(stubFetch(abort))
    expect(aborted).toBe(abort)
  })
})

describe('e621Adapter.refresh', () => {
  it('fetches /posts/<id>.json with _client and returns a fresh post', async () => {
    const fetch = stubFetch(jsonResponse({ post: videoRow }))
    const stale = normalizeE621Post(videoRow)
    const fresh = await e621Adapter.refresh(stale, { signal: undefined, api: {}, fetch })

    const url = requestedUrl(fetch)
    expect(`${url.origin}${url.pathname}`).toBe('https://e621.net/posts/6336267.json')
    expect(Object.fromEntries(url.searchParams)).toEqual({ _client: 'NekoBooru/1.0' })
    expect(fresh).toEqual(stale)
  })

  it('throws unavailable for a post that lost its file', async () => {
    const error = await e621Adapter.refresh({ id: '6775146' }, { fetch: stubFetch(jsonResponse({ post: deletedRow })) }).catch((caught) => caught)
    expect(error).toBeInstanceOf(RemoteSearchError)
    expect(error).toMatchObject({ kind: 'unavailable', site: 'e621' })
  })

  it('throws unavailable for a 404 and maps other errors as search does', async () => {
    const missing = await e621Adapter.refresh({ id: '1' }, { fetch: stubFetch(jsonResponse({ success: false }, { status: 404 })) }).catch((caught) => caught)
    expect(missing).toMatchObject({ kind: 'unavailable', status: 404 })

    const throttled = await e621Adapter.refresh({ id: '1' }, { fetch: stubFetch(new Response('', { status: 429, headers: { 'Retry-After': '3' } })) }).catch((caught) => caught)
    expect(throttled).toMatchObject({ kind: 'throttled', retryAfterMs: 3000 })
  })
})

describe('e621Adapter shape', () => {
  it('is a frozen browser adapter with the site default page size', () => {
    expect(Object.isFrozen(e621Adapter)).toBe(true)
    expect(e621Adapter).toMatchObject({ id: 'e621', label: 'e621 / e926', transport: 'browser', pageSize: 75 })
  })
})
