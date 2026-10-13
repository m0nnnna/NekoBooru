import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDanbooruCategoryResolver } from './danbooruCategories.js'
import { useImportQueue } from './useImportQueue'

// Safebooru imports get their tag categories from Danbooru (P7); these tests
// drive the queue with a resolver whose fetch is a fake Danbooru.

function post(site, id, tags, extra = {}) {
  return {
    key: `${site}:${id}`,
    site,
    id: String(id),
    postUrl: `https://${site}.example/posts/${id}`,
    fileUrl: `https://cdn.${site}.example/original/${id}.png`,
    safety: 'safe',
    tags,
    tagCategories: Object.fromEntries(tags.map((tag) => [tag, 'general'])),
    tagDisplayNames: {},
    ...extra,
  }
}

function fakeApi() {
  let nextId = 100
  return {
    fetchFromUrl: vi.fn(async ({ url }) => ({ token: `tok:${url}` })),
    getFromUrlProgress: vi.fn(async () => ({ received: 0, total: 0 })),
    createPost: vi.fn(async () => ({ id: nextId++ })),
    gelbooruTagCategories: vi.fn(async () => ({ categories: {} })),
    danbooruNames: vi.fn(async () => ({ renames: {} })),
    createAlias: vi.fn(async () => ({})),
  }
}

function fakeDanbooru(known = {}) {
  return vi.fn(async (url) => {
    const names = new URL(url).searchParams.get('search[name_comma]').split(',')
    const rows = names.filter((name) => name in known).map((name) => ({ name, category: known[name] }))
    return { ok: true, status: 200, json: async () => rows }
  })
}

const notInLibrary = () => ({ lookupNow: vi.fn(async () => null) })
const askedNames = (fetch) => fetch.mock.calls.flatMap(([url]) => new URL(url).searchParams.get('search[name_comma]').split(','))

async function drain(queue) {
  const run = queue.start()
  await vi.advanceTimersByTimeAsync(60000)
  await run
}

describe('useImportQueue Safebooru categories', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves Safebooru tags through Danbooru, 80 names a request, by the booru spelling', async () => {
    const api = fakeApi()
    const fetch = fakeDanbooru({ templus: 1, 'miyu_(blue_archive)': 4, blue_archive: 3, highres: 5 })
    const resolver = createDanbooruCategoryResolver({ fetch, storage: null })
    const queue = useImportQueue({ api, inLibrary: notInLibrary(), danbooruCategories: resolver.resolve })
    const filler = Array.from({ length: 90 }, (_, index) => `filler_${index}`)
    queue.enqueue([
      post('safebooru', 1, ['templus', 'miyu_blue_archive', 'blue_archive', ...filler], {
        tagDisplayNames: { miyu_blue_archive: 'miyu (blue archive)' },
      }),
      post('safebooru', 2, ['templus', 'highres', 'solo']),
    ])
    await drain(queue)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(askedNames(fetch)).toHaveLength(95)
    expect(askedNames(fetch)).toContain('miyu_(blue_archive)')
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('limit')).toBe('80')
    const first = api.createPost.mock.calls[0][0].tagCategories
    expect(first).toMatchObject({ templus: 'artist', miyu_blue_archive: 'character', blue_archive: 'copyright', filler_0: 'general', safebooru_1: 'meta' })
    expect(api.createPost.mock.calls[1][0].tagCategories).toEqual({ templus: 'artist', highres: 'meta', solo: 'general', safebooru_2: 'meta' })
    expect(api.gelbooruTagCategories).not.toHaveBeenCalled()
  })

  it('only asks Danbooru about Safebooru posts', async () => {
    const api = fakeApi()
    const danbooruCategories = vi.fn(async () => ({ templus: 'artist' }))
    const queue = useImportQueue({ api, inLibrary: notInLibrary(), danbooruCategories })
    queue.enqueue([
      post('gelbooru', 1, ['templus']),
      post('danbooru', 2, ['templus']),
      post('e621', 3, ['templus']),
      post('sankaku', 4, ['templus']),
    ])
    await drain(queue)

    expect(danbooruCategories).not.toHaveBeenCalled()
    expect(api.gelbooruTagCategories).toHaveBeenCalledWith(['templus'])
    expect(api.createPost.mock.calls[1][0].tagCategories).toEqual({ templus: 'general', danbooru_2: 'meta' })

    // A Safebooru post in the same mix gets only its own lookup.
    queue.enqueue([post('safebooru', 5, ['templus', 'tagged'], { tagCategories: { templus: 'general', tagged: 'copyright' } })])
    await drain(queue)
    expect(danbooruCategories).toHaveBeenCalledTimes(1)
    expect(danbooruCategories.mock.calls[0][0]).toEqual(['templus'])
    expect(api.createPost.mock.calls[4][0].tagCategories).toEqual({ templus: 'artist', tagged: 'copyright', safebooru_5: 'meta' })
  })

  it('imports as general when Danbooru fails, and reuses cached answers on the next run', async () => {
    const api = fakeApi()
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(fakeDanbooru({ templus: 1 }))
    const resolver = createDanbooruCategoryResolver({ fetch, storage: null })
    const queue = useImportQueue({ api, inLibrary: notInLibrary(), danbooruCategories: resolver.resolve })

    queue.enqueue([post('safebooru', 1, ['templus'])])
    await drain(queue)
    expect(queue.items[0].status).toBe('done')
    expect(api.createPost.mock.calls[0][0].tagCategories).toEqual({ templus: 'general', safebooru_1: 'meta' })

    queue.enqueue([post('safebooru', 2, ['templus'])])
    await drain(queue)
    expect(api.createPost.mock.calls[1][0].tagCategories).toEqual({ templus: 'artist', safebooru_2: 'meta' })

    queue.enqueue([post('safebooru', 3, ['templus'])])
    await drain(queue)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(api.createPost.mock.calls[2][0].tagCategories).toEqual({ templus: 'artist', safebooru_3: 'meta' })
  })

  it('a resolver that throws or hangs until cancel never fails the import', async () => {
    const api = fakeApi()
    const throwing = useImportQueue({ api, inLibrary: notInLibrary(), danbooruCategories: vi.fn(async () => { throw new Error('boom') }) })
    throwing.enqueue([post('safebooru', 1, ['templus'])])
    await drain(throwing)
    expect(throwing.items[0]).toMatchObject({ status: 'done' })

    let seenSignal = null
    const hanging = vi.fn((names, { signal }) => new Promise((resolve) => {
      seenSignal = signal
      signal.addEventListener('abort', () => resolve({}))
    }))
    const queue = useImportQueue({ api, inLibrary: notInLibrary(), danbooruCategories: hanging })
    queue.enqueue([post('safebooru', 2, ['templus'])])
    const run = queue.start()
    await vi.advanceTimersByTimeAsync(0)
    queue.cancel()
    await run
    expect(seenSignal.aborted).toBe(true)
    expect(queue.items[0].status).toBe('cancelled')
  })
})
