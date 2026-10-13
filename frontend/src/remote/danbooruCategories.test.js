import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DANBOORU_CATEGORY_STORAGE_KEY,
  DANBOORU_CATEGORY_TTL_MS,
  createDanbooruCategoryResolver,
  danbooruCategoryName,
  danbooruLookupName,
} from './danbooruCategories.js'

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body }
}

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) },
  }
}

// A fake Danbooru: answers name_comma lookups from `known` (name -> number).
function fakeDanbooru(known = {}) {
  return vi.fn(async (url) => {
    const params = new URL(url).searchParams
    const names = params.get('search[name_comma]').split(',')
    return jsonResponse(names.filter((name) => name in known).map((name) => ({ name, category: known[name] })))
  })
}

const requestedNames = (fetch, call) => new URL(fetch.mock.calls[call][0]).searchParams.get('search[name_comma]').split(',')

describe('danbooruCategories', () => {
  let clock = 1_000_000
  const now = () => clock

  beforeEach(() => {
    clock = 1_000_000
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('maps Danbooru category numbers and rejects names name_comma cannot carry', () => {
    expect([0, 1, 3, 4, 5, 2, 9, null].map(danbooruCategoryName))
      .toEqual(['general', 'artist', 'copyright', 'character', 'meta', 'general', 'general', 'general'])
    expect(danbooruLookupName(' Miyu_(Blue_Archive) ')).toBe('miyu_(blue_archive)')
    expect(danbooruLookupName('a,b')).toBe('')
    expect(danbooruLookupName('two words')).toBe('')
    expect(danbooruLookupName('')).toBe('')
  })

  it('asks 80 names per request with only name and category', async () => {
    const names = Array.from({ length: 170 }, (_, index) => `tag_${index}`)
    const fetch = fakeDanbooru({ tag_0: 1, tag_85: 4, tag_169: 3, tag_10: 5 })
    const { resolve } = createDanbooruCategoryResolver({ fetch, storage: null, now })

    const answer = await resolve(names)

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(requestedNames(fetch, 0)).toHaveLength(80)
    expect(requestedNames(fetch, 1)).toHaveLength(80)
    expect(requestedNames(fetch, 2)).toHaveLength(10)
    const url = new URL(fetch.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://danbooru.donmai.us/tags.json')
    expect(url.searchParams.get('only')).toBe('name,category')
    expect(url.searchParams.get('limit')).toBe('80')
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(answer).toMatchObject({ tag_0: 'artist', tag_85: 'character', tag_169: 'copyright', tag_10: 'meta', tag_1: 'general' })
    expect(Object.keys(answer)).toHaveLength(170)
  })

  it('answers repeated names from the cache for a day, across page loads', async () => {
    const storage = memoryStorage()
    const fetch = fakeDanbooru({ templus: 1 })
    const first = createDanbooruCategoryResolver({ fetch, storage, now })
    expect(await first.resolve(['templus', 'solo'])).toEqual({ templus: 'artist', solo: 'general' })
    expect(await first.resolve(['solo', 'templus'])).toEqual({ templus: 'artist', solo: 'general' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.data[DANBOORU_CATEGORY_STORAGE_KEY])).toEqual({ templus: ['artist', clock], solo: ['general', clock] })

    // A new page with the same storage reuses the answers...
    const second = createDanbooruCategoryResolver({ fetch, storage, now })
    clock += DANBOORU_CATEGORY_TTL_MS - 1
    expect(await second.resolve(['templus'])).toEqual({ templus: 'artist' })
    expect(fetch).toHaveBeenCalledTimes(1)

    // ...until they are a day old.
    clock += 1
    expect(await second.resolve(['templus'])).toEqual({ templus: 'artist' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('leaves a failed batch out, never throws, and asks again next time', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ message: 'down' }, 502))
      .mockResolvedValueOnce(jsonResponse('not a list'))
      .mockImplementation(fakeDanbooru({ templus: 1 }))
    const { resolve } = createDanbooruCategoryResolver({ fetch, storage: null, now })

    expect(await resolve(['templus'])).toEqual({})
    expect(await resolve(['templus'])).toEqual({})
    expect(await resolve(['templus'])).toEqual({})
    expect(await resolve(['templus'])).toEqual({ templus: 'artist' })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('stops after a throttled batch instead of trying the rest', async () => {
    const fetch = vi.fn(async () => jsonResponse({}, 429))
    const { resolve } = createDanbooruCategoryResolver({ fetch, storage: null, now, batchSize: 2 })
    expect(await resolve(['a', 'b', 'c', 'd'])).toEqual({})
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('gives up on a request that outlives its timeout or an abort', async () => {
    vi.useFakeTimers()
    const hanging = vi.fn((url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const { resolve } = createDanbooruCategoryResolver({ fetch: hanging, storage: null, now, timeoutMs: 5000 })
    const timed = resolve(['templus'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(await timed).toEqual({})

    const controller = new AbortController()
    const aborted = resolve(['a', 'b'], { signal: controller.signal })
    controller.abort()
    expect(await aborted).toEqual({})
    expect(hanging).toHaveBeenCalledTimes(2)
  })

  it('survives unreadable storage', async () => {
    const storage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('quota') },
    }
    const fetch = fakeDanbooru({ templus: 1 })
    const { resolve } = createDanbooruCategoryResolver({ fetch, storage, now })
    expect(await resolve(['templus'])).toEqual({ templus: 'artist' })
    expect(await resolve(['templus'])).toEqual({ templus: 'artist' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
