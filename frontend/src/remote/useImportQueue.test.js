import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteSearchError } from './types.js'
import { downloadProgressText, useImportQueue } from './useImportQueue'

function remotePost(site, id, extra = {}) {
  return {
    key: `${site}:${id}`,
    site,
    id: String(id),
    postUrl: `https://${site}.example/posts/${id}`,
    thumbUrl: null,
    sampleUrl: null,
    fileUrl: `https://cdn.${site}.example/original/${id}.png`,
    fileExt: 'png',
    mediaType: 'image',
    safety: 'safe',
    rawRating: 'g',
    tags: ['1girl'],
    tagCategories: { '1girl': 'general' },
    tagDisplayNames: {},
    source: null,
    unavailable: null,
    referer: `https://${site}.example/`,
    ...extra,
  }
}

function httpError(status, message, detail = message) {
  const error = new Error(message)
  error.status = status
  error.detail = detail
  return error
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeApi(overrides = {}) {
  let nextId = 100
  return {
    fetchFromUrl: vi.fn(async ({ url }) => ({ token: `tok:${url}` })),
    getFromUrlProgress: vi.fn(async () => ({ received: 0, total: 0, done: false })),
    createPost: vi.fn(async () => ({ id: nextId++ })),
    getPost: vi.fn(async (id) => ({ id, tags: ['old_tag'], safety: 'sketchy', source: '' })),
    updatePost: vi.fn(async (id, body) => ({ id, ...body })),
    restorePost: vi.fn(async (id) => ({ id, tags: ['restored'], safety: 'unsafe', source: 'https://pixiv.example/1' })),
    gelbooruTagCategories: vi.fn(async () => ({ categories: {} })),
    danbooruNames: vi.fn(async () => ({ renames: {} })),
    createAlias: vi.fn(async () => ({})),
    createPool: vi.fn(async ({ name }) => ({ id: 9, name })),
    addPostsToPool: vi.fn(async () => ({})),
    ...overrides,
  }
}

function notInLibrary() {
  return { lookupNow: vi.fn(async () => null) }
}

// Lets every pending promise chain settle without moving the fake clock.
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('useImportQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('imports in order, one item at a time, and reports each import', async () => {
    const downloads = []
    const api = fakeApi({
      fetchFromUrl: vi.fn(({ url }) => {
        const pending = deferred()
        downloads.push({ url, pending })
        return pending.promise
      }),
    })
    const onImported = vi.fn()
    const queue = useImportQueue({ api, inLibrary: notInLibrary(), onImported })
    queue.enqueue([remotePost('danbooru', 1), remotePost('danbooru', 2)])
    const run = queue.start()
    expect(queue.running.value).toBe(true)
    await settle()

    expect(downloads.map((entry) => entry.url)).toEqual(['https://cdn.danbooru.example/original/1.png'])
    expect(queue.items.map((item) => item.status)).toEqual(['downloading', 'queued'])

    downloads[0].pending.resolve({ token: 'one' })
    await settle()
    expect(queue.items[0]).toMatchObject({ status: 'done', postId: 100, duplicate: false, message: 'Imported · #100' })
    expect(onImported).toHaveBeenCalledWith('danbooru:1', 100, { id: 100 })
    expect(downloads).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1500)
    expect(downloads).toHaveLength(2)
    downloads[1].pending.resolve({ token: 'two' })
    await run

    expect(onImported).toHaveBeenNthCalledWith(2, 'danbooru:2', 101, { id: 101 })
    expect(queue.running.value).toBe(false)
    expect(queue.progress.value).toEqual({ done: 2, total: 2, failed: 0, skipped: 0 })
  })

  it('merges into the library copy instead of downloading a post already imported', async () => {
    const api = fakeApi()
    const inLibrary = { lookupNow: vi.fn(async (key) => (key === 'danbooru:1' ? { postId: 42 } : null)) }
    const onImported = vi.fn()
    const queue = useImportQueue({ api, inLibrary, onImported })
    const post = remotePost('danbooru', 1, {
      safety: 'unsafe',
      tags: ['1girl', 'miyu_blue_archive'],
      tagCategories: { '1girl': 'general', miyu_blue_archive: 'character' },
      tagDisplayNames: { miyu_blue_archive: 'miyu (blue archive)' },
    })
    queue.enqueue([post])
    await queue.start()

    expect(inLibrary.lookupNow).toHaveBeenCalledWith('danbooru:1')
    expect(api.getPost).toHaveBeenCalledWith(42)
    expect(api.fetchFromUrl).not.toHaveBeenCalled()
    expect(api.createPost).not.toHaveBeenCalled()
    // The extension's mergeDuplicate body: library tags first, stricter rating.
    const body = {
      tags: ['old_tag', '1girl', 'miyu_blue_archive', 'danbooru_1'],
      safety: 'unsafe',
      source: 'https://danbooru.example/posts/1',
      tagCategories: { '1girl': 'general', miyu_blue_archive: 'character', danbooru_1: 'meta' },
      tagDisplayNames: { miyu_blue_archive: 'miyu (blue archive)' },
    }
    expect(api.updatePost).toHaveBeenCalledWith(42, body)
    expect(queue.items[0]).toMatchObject({
      status: 'skipped',
      postId: 42,
      message: 'Already in NekoBooru · tags merged · #42',
    })
    expect(onImported).toHaveBeenCalledWith('danbooru:1', 42, { id: 42, ...body })
  })

  it('keeps the library source when merging and waits 1.5 s only after a download', async () => {
    const api = fakeApi({
      getPost: vi.fn(async (id) => ({ id, tags: [], safety: 'safe', source: 'https://kept.example' })),
    })
    const inLibrary = { lookupNow: vi.fn(async (key) => (key === 'danbooru:2' ? { postId: 7 } : null)) }
    const queue = useImportQueue({ api, inLibrary })
    queue.enqueue(['1', '2', '3', '4'].map((id) => remotePost('danbooru', id)))
    const run = queue.start()
    await settle()

    // 1 downloads, 2 is merged (no download, no gap), 3 follows a skip so it
    // starts at once, 4 follows a download and waits.
    expect(queue.items.map((item) => item.status)).toEqual(['done', 'skipped', 'done', 'checking'])
    expect(api.updatePost.mock.calls[0][1].source).toBe('https://kept.example')
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1499)
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(2)
    expect(queue.items[3].message).toBe('Waiting between downloads…')
    await vi.advanceTimersByTimeAsync(1)
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(3)
    await run
    expect(queue.items.map((item) => item.status)).toEqual(['done', 'skipped', 'done', 'done'])
  })

  it('backs off 10, 30 and 60 s on HTTP 429/503, then fails and moves on', async () => {
    const api = fakeApi({
      fetchFromUrl: vi.fn(async ({ url }) => {
        if (url.endsWith('/1.png')) throw httpError(400, 'Failed to fetch URL: HTTP 429')
        return { token: 'ok' }
      }),
    })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('e621', 1), remotePost('e621', 2)])
    const run = queue.start()
    await settle()

    const item = queue.items[0]
    expect(item).toMatchObject({ status: 'retrying', attempt: 1 })
    expect(item.message).toBe('e621 asked to slow down · retrying in 10 s…')
    await vi.advanceTimersByTimeAsync(9999)
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(2)
    expect(item).toMatchObject({ status: 'retrying', attempt: 2 })
    await vi.advanceTimersByTimeAsync(30000)
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(3)
    expect(item).toMatchObject({ status: 'retrying', attempt: 3 })
    expect(item.message).toContain('60 s')
    await vi.advanceTimersByTimeAsync(60000)
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(4)
    expect(item).toMatchObject({ status: 'failed', message: 'Failed to fetch URL: HTTP 429' })

    await vi.advanceTimersByTimeAsync(1500)
    await run
    expect(queue.items[1].status).toBe('done')
    expect(queue.progress.value).toEqual({ done: 1, total: 2, failed: 1, skipped: 0 })
  })

  it('retries after a 503 and succeeds; an unrelated error fails without retrying', async () => {
    let calls = 0
    const api = fakeApi({
      fetchFromUrl: vi.fn(async ({ url }) => {
        if (url.endsWith('/2.png')) throw httpError(400, 'Failed to fetch URL: HTTP 404')
        calls += 1
        if (calls === 1) throw httpError(400, 'Failed to fetch URL: HTTP 503')
        return { token: 'ok' }
      }),
    })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('danbooru', 1), remotePost('danbooru', 2)])
    const run = queue.start()
    await vi.advanceTimersByTimeAsync(10000)
    expect(queue.items[0]).toMatchObject({ status: 'done', attempt: 1 })
    await vi.advanceTimersByTimeAsync(1500)
    await run
    expect(queue.items[1]).toMatchObject({ status: 'failed', message: 'Failed to fetch URL: HTTP 404', attempt: 0 })
  })

  it('treats a 429/503 status as throttling and honours retryAfter / retryAfterMs', async () => {
    let calls = 0
    const throttled = [
      httpError(429, 'slow down', { code: 'upstream_throttled', message: 'slow down', retryAfter: 45 }),
      httpError(503, 'Service unavailable'),
    ]
    const api = fakeApi({
      fetchFromUrl: vi.fn(async () => {
        calls += 1
        if (calls <= throttled.length) throw throttled[calls - 1]
        return { token: 'ok' }
      }),
    })
    const adapters = {
      sankaku: {
        refresh: vi.fn()
          .mockRejectedValueOnce(new RemoteSearchError({ site: 'sankaku', status: 429, kind: 'throttled', retryAfterMs: 120000 }))
          .mockImplementation(async (post) => post),
      },
    }
    const queue = useImportQueue({ api, adapters, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('gelbooru', 1), remotePost('sankaku', 'aB')])
    const run = queue.start()
    await settle()

    // detail.retryAfter (45 s) beats the scheduled 10 s.
    expect(queue.items[0]).toMatchObject({ status: 'retrying', attempt: 1 })
    expect(queue.items[0].message).toBe('Gelbooru asked to slow down · retrying in 45 s…')
    await vi.advanceTimersByTimeAsync(44999)
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    // A bare 503 status (no hint) waits the scheduled 30 s.
    expect(queue.items[0]).toMatchObject({ status: 'retrying', attempt: 2 })
    expect(queue.items[0].message).toContain('30 s')
    await vi.advanceTimersByTimeAsync(30000)
    expect(queue.items[0].status).toBe('done')

    // RemoteSearchError.retryAfterMs from a refresh: 120 s instead of 10 s.
    await vi.advanceTimersByTimeAsync(1500)
    expect(queue.items[1]).toMatchObject({ status: 'retrying', attempt: 1 })
    expect(queue.items[1].message).toContain('120 s')
    await vi.advanceTimersByTimeAsync(119999)
    expect(adapters.sankaku.refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await run
    expect(queue.items[1].status).toBe('done')
  })

  it('waits 5 s once when the same file is already downloading, then fails', async () => {
    const busy = () => httpError(409, 'This file is already downloading. Wait for that import to finish.')
    let first = true
    const api = fakeApi({
      fetchFromUrl: vi.fn(async ({ url }) => {
        if (url.endsWith('/2.png')) throw busy()
        if (first) {
          first = false
          throw busy()
        }
        return { token: 'ok' }
      }),
    })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('danbooru', 1), remotePost('danbooru', 2)])
    const run = queue.start()
    await settle()
    expect(queue.items[0].status).toBe('retrying')
    await vi.advanceTimersByTimeAsync(5000)
    expect(queue.items[0].status).toBe('done')
    await vi.advanceTimersByTimeAsync(1500 + 5000)
    await run
    expect(queue.items[1].status).toBe('failed')
    expect(queue.items[1].message).toContain('already downloading')
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(4)
  })

  it('restores a soft-deleted duplicate and merges into it on 409 duplicate_post', async () => {
    const deletedCopy = { id: 7, tags: ['gone'], safety: 'safe', source: '', deletedAt: '2026-01-01T00:00:00' }
    const api = fakeApi({
      createPost: vi.fn(async () => {
        throw httpError(409, 'Same post detected.', {
          code: 'duplicate_post',
          message: 'Same post detected.',
          post: deletedCopy,
          postId: 7,
          postUrl: '/post/7',
          sha256: 'abc',
          deleted: true,
        })
      }),
    })
    const onImported = vi.fn()
    const queue = useImportQueue({ api, inLibrary: notInLibrary(), onImported })
    queue.enqueue([remotePost('gelbooru', 5, { safety: 'sketchy' })])
    await queue.start()

    expect(api.restorePost).toHaveBeenCalledWith(7)
    const body = {
      tags: ['restored', '1girl', 'gelbooru_5'],
      safety: 'unsafe',
      source: 'https://pixiv.example/1',
      tagCategories: { '1girl': 'general', gelbooru_5: 'meta' },
      tagDisplayNames: {},
    }
    expect(api.updatePost).toHaveBeenCalledWith(7, body)
    expect(queue.items[0]).toMatchObject({ status: 'done', duplicate: true, postId: 7 })
    expect(onImported).toHaveBeenCalledWith('gelbooru:5', 7, { id: 7, ...body })
  })

  it('merges a live duplicate without restoring it', async () => {
    const api = fakeApi({
      createPost: vi.fn(async () => {
        throw httpError(409, 'Same post detected.', {
          code: 'duplicate_post',
          post: { id: 8, tags: ['kept'], safety: 'safe', source: 'https://orig.example', deletedAt: null },
          postId: 8,
          deleted: false,
        })
      }),
    })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('safebooru', 3)])
    await queue.start()

    expect(api.restorePost).not.toHaveBeenCalled()
    expect(api.updatePost).toHaveBeenCalledWith(8, expect.objectContaining({
      tags: ['kept', '1girl', 'safebooru_3'],
      safety: 'safe',
      source: 'https://orig.example',
    }))
    expect(queue.items[0]).toMatchObject({ status: 'done', duplicate: true, postId: 8 })
  })

  it('fails an item when post creation fails for another reason', async () => {
    const api = fakeApi({ createPost: vi.fn(async () => { throw httpError(400, 'Unsupported file type') }) })
    const onImported = vi.fn()
    const queue = useImportQueue({ api, inLibrary: notInLibrary(), onImported })
    queue.enqueue([remotePost('danbooru', 1)])
    await queue.start()
    expect(queue.items[0]).toMatchObject({ status: 'failed', message: 'Unsupported file type' })
    expect(onImported).not.toHaveBeenCalled()
  })

  it('posts the 3.7 createPost body with the id tag, extra tags, override and autoTag', async () => {
    const api = fakeApi()
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    Object.assign(queue.options, { autoTag: true, extraTags: ['Extra Tag', '1girl', ''], safetyOverride: 'unsafe' })
    const post = remotePost('danbooru', 12370916, {
      tags: ['1girl', 'miyu_blue_archive'],
      tagCategories: { '1girl': 'general', miyu_blue_archive: 'character' },
      tagDisplayNames: { miyu_blue_archive: 'miyu (blue archive)' },
    })
    queue.enqueue([post])
    await queue.start()

    expect(api.fetchFromUrl).toHaveBeenCalledWith({
      url: post.fileUrl,
      referer: 'https://danbooru.example/',
      progressId: expect.any(String),
    })
    expect(api.createPost).toHaveBeenCalledWith({
      contentToken: `tok:${post.fileUrl}`,
      safety: 'unsafe',
      tags: ['1girl', 'miyu_blue_archive', 'extra_tag', 'danbooru_12370916'],
      tagCategories: { '1girl': 'general', miyu_blue_archive: 'character', danbooru_12370916: 'meta' },
      tagDisplayNames: { miyu_blue_archive: 'miyu (blue archive)' },
      source: 'https://danbooru.example/posts/12370916',
      autoTag: true,
      autoTagProfile: 'booru_search',
    })
  })

  it('defaults to autoTag off and the post rating', async () => {
    const api = fakeApi()
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    expect(queue.options).toEqual({ autoTag: false, extraTags: [], safetyOverride: '', poolId: null, newPoolName: '' })
    queue.enqueue([remotePost('e621', 4, { safety: 'sketchy', tags: ['e621_4', 'fox'], tagCategories: { fox: 'general' } })])
    await queue.start()
    const body = api.createPost.mock.calls[0][0]
    expect(body).toMatchObject({ autoTag: false, safety: 'sketchy', autoTagProfile: 'booru_search' })
    expect(body.tags).toEqual(['e621_4', 'fox'])
    expect(body.tagCategories.e621_4).toBe('meta')
  })

  it('applies Danbooru spellings to Sankaku and e621 posts and aliases the source spelling', async () => {
    const api = fakeApi({
      danbooruNames: vi.fn(async () => ({
        renames: { 'honoka_(dead_or_alive)': 'honoka_(doa)', 'kasumi_(dead_or_alive)': 'kasumi_(doa)' },
      })),
    })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    const sankaku = remotePost('sankaku', 'zjrmD0QxWaD', {
      tags: ['honoka_dead_or_alive', 'dead_or_alive', '1girl'],
      tagCategories: { honoka_dead_or_alive: 'character', dead_or_alive: 'copyright', '1girl': 'general' },
      tagDisplayNames: { honoka_dead_or_alive: 'honoka (dead or alive)' },
    })
    const e621 = remotePost('e621', 9, {
      tags: ['kasumi_dead_or_alive'],
      tagCategories: { kasumi_dead_or_alive: 'character' },
      tagDisplayNames: { kasumi_dead_or_alive: 'kasumi (dead or alive)' },
    })
    const danbooru = remotePost('danbooru', 3, {
      tags: ['ayane_dead_or_alive'],
      tagCategories: { ayane_dead_or_alive: 'character' },
      tagDisplayNames: { ayane_dead_or_alive: 'ayane (dead or alive)' },
    })
    queue.enqueue([sankaku, e621, danbooru])
    const run = queue.start()
    await vi.advanceTimersByTimeAsync(5000)
    await run

    // One lookup for the whole run, in the booru's own spelling, Danbooru posts excluded.
    expect(api.danbooruNames).toHaveBeenCalledTimes(1)
    expect(api.danbooruNames).toHaveBeenCalledWith(
      ['honoka_(dead_or_alive)', 'dead_or_alive', 'kasumi_(dead_or_alive)'],
      { 'honoka_(dead_or_alive)': 'character', dead_or_alive: 'copyright', 'kasumi_(dead_or_alive)': 'character' },
    )
    expect(api.createPost.mock.calls[0][0]).toMatchObject({
      tags: ['honoka_doa', 'dead_or_alive', '1girl', 'sankaku_zjrmd0qxwad'],
      tagCategories: { honoka_doa: 'character', dead_or_alive: 'copyright', '1girl': 'general', sankaku_zjrmd0qxwad: 'meta' },
    })
    expect(api.createPost.mock.calls[0][0].tagDisplayNames).toEqual({ honoka_doa: 'honoka (doa)' })
    expect(api.createPost.mock.calls[1][0].tags).toEqual(['kasumi_doa', 'e621_9'])
    expect(api.createPost.mock.calls[2][0].tags).toEqual(['ayane_dead_or_alive', 'danbooru_3'])

    expect(api.createAlias).toHaveBeenCalledTimes(2)
    expect(api.createAlias).toHaveBeenNthCalledWith(1, {
      alias: 'honoka_(dead_or_alive)',
      target: 'honoka_(doa)',
      sankakuName: 'honoka_(dead_or_alive)',
    })
    const e621Alias = api.createAlias.mock.calls[1][0]
    expect(e621Alias).toEqual({ alias: 'kasumi_(dead_or_alive)', target: 'kasumi_(doa)' })
    expect(e621Alias).not.toHaveProperty('sankakuName')
  })

  it('imports with the source spelling when the Danbooru lookup or an alias fails', async () => {
    const api = fakeApi({
      danbooruNames: vi.fn(async () => { throw new Error('offline') }),
    })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('sankaku', 'abc', {
      tags: ['honoka_dead_or_alive'],
      tagCategories: { honoka_dead_or_alive: 'character' },
      tagDisplayNames: { honoka_dead_or_alive: 'honoka (dead or alive)' },
    })])
    await queue.start()
    expect(queue.items[0].status).toBe('done')
    expect(api.createPost.mock.calls[0][0].tags).toEqual(['honoka_dead_or_alive', 'sankaku_abc'])
    expect(api.createAlias).not.toHaveBeenCalled()
  })

  it('fetches Gelbooru categories once per run and keeps general when that fails', async () => {
    const api = fakeApi({
      gelbooruTagCategories: vi.fn(async () => ({
        categories: { templus: 'artist', 'miyu_(blue_archive)': 'character', solo: 'general', azur_lane: 'bogus' },
      })),
    })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    const general = (tags) => Object.fromEntries(tags.map((tag) => [tag, 'general']))
    queue.enqueue([
      remotePost('gelbooru', 1, {
        tags: ['templus', 'solo'],
        tagCategories: general(['templus', 'solo']),
      }),
      remotePost('gelbooru', 2, {
        tags: ['miyu_blue_archive', 'solo', 'azur_lane'],
        tagCategories: general(['miyu_blue_archive', 'solo', 'azur_lane']),
        tagDisplayNames: { miyu_blue_archive: 'miyu (blue archive)' },
      }),
      remotePost('danbooru', 3),
    ])
    const run = queue.start()
    await vi.advanceTimersByTimeAsync(5000)
    await run

    expect(api.gelbooruTagCategories).toHaveBeenCalledTimes(1)
    expect(api.gelbooruTagCategories).toHaveBeenCalledWith(['templus', 'solo', 'miyu_(blue_archive)', 'azur_lane'])
    expect(api.createPost.mock.calls[0][0].tagCategories).toEqual({ templus: 'artist', solo: 'general', gelbooru_1: 'meta' })
    expect(api.createPost.mock.calls[1][0].tagCategories).toEqual({
      miyu_blue_archive: 'character',
      solo: 'general',
      azur_lane: 'general',
      gelbooru_2: 'meta',
    })

    // A second run asks again; a failed lookup leaves the tags general.
    api.gelbooruTagCategories.mockRejectedValueOnce(new Error('HTTP 502'))
    queue.enqueue([remotePost('gelbooru', 4, { tags: ['templus'], tagCategories: { templus: 'general' } })])
    await queue.start()
    expect(api.gelbooruTagCategories).toHaveBeenCalledTimes(2)
    expect(queue.items[3].status).toBe('done')
    expect(api.createPost.mock.calls[3][0].tagCategories).toEqual({ templus: 'general', gelbooru_4: 'meta' })
  })

  it('adds every imported and merged post to the pool once, after the queue drains', async () => {
    const api = fakeApi()
    const inLibrary = { lookupNow: vi.fn(async (key) => (key === 'danbooru:2' ? { postId: 42 } : null)) }
    const queue = useImportQueue({ api, inLibrary })
    queue.options.poolId = 5
    queue.enqueue([
      remotePost('danbooru', 1),
      remotePost('danbooru', 4),
      remotePost('danbooru', 2),
      remotePost('danbooru', 3, { fileUrl: null }),
    ])
    const run = queue.start()
    await settle()
    expect(queue.items[0].status).toBe('done')
    expect(api.addPostsToPool).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    await run

    expect(queue.items.map((item) => item.status)).toEqual(['done', 'done', 'skipped', 'failed'])
    expect(api.addPostsToPool).toHaveBeenCalledTimes(1)
    expect(api.addPostsToPool).toHaveBeenCalledWith(5, [100, 101, 42])
    expect(api.createPool).not.toHaveBeenCalled()
    expect(queue.poolResult.value).toEqual({ poolId: 5, added: 3, error: null })
  })

  it('creates a new pool when asked to', async () => {
    const api = fakeApi()
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    Object.assign(queue.options, { poolId: '__new__', newPoolName: '  Cat ears  ' })
    queue.enqueue([remotePost('danbooru', 1)])
    await queue.start()
    expect(api.createPool).toHaveBeenCalledWith({ name: 'Cat ears' })
    expect(api.addPostsToPool).toHaveBeenCalledWith(9, [100])
  })

  it('does not touch pools when nothing was imported', async () => {
    const api = fakeApi({ fetchFromUrl: vi.fn(async () => { throw new Error('Failed to fetch URL: HTTP 404') }) })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.options.poolId = '__new__'
    queue.enqueue([remotePost('danbooru', 1)])
    await queue.start()
    expect(api.createPool).not.toHaveBeenCalled()
    expect(api.addPostsToPool).not.toHaveBeenCalled()
  })

  it('cancel() finishes the current item and cancels the rest', async () => {
    const pending = deferred()
    const api = fakeApi({ fetchFromUrl: vi.fn(() => pending.promise) })
    const onImported = vi.fn()
    const queue = useImportQueue({ api, inLibrary: notInLibrary(), onImported })
    queue.enqueue(['1', '2', '3'].map((id) => remotePost('danbooru', id)))
    const run = queue.start()
    await settle()
    expect(queue.items[0].status).toBe('downloading')

    queue.cancel()
    expect(queue.items.map((item) => item.status)).toEqual(['downloading', 'cancelled', 'cancelled'])
    pending.resolve({ token: 'one' })
    await run

    expect(queue.items.map((item) => item.status)).toEqual(['done', 'cancelled', 'cancelled'])
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)
    expect(onImported).toHaveBeenCalledTimes(1)
    expect(queue.running.value).toBe(false)
  })

  it('cancel() during a back-off wait stops the wait at once', async () => {
    const api = fakeApi({ fetchFromUrl: vi.fn(async () => { throw new Error('Failed to fetch URL: HTTP 429') }) })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('danbooru', 1), remotePost('danbooru', 2)])
    const run = queue.start()
    await settle()
    expect(queue.items[0].status).toBe('retrying')
    queue.cancel()
    await run
    expect(queue.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled'])
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)
  })

  it('can import again after a cancel', async () => {
    const api = fakeApi()
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('danbooru', 1)])
    queue.cancel()
    expect(queue.items[0].status).toBe('cancelled')
    queue.enqueue([remotePost('danbooru', 1)])
    expect(queue.items).toHaveLength(1)
    await queue.start()
    expect(queue.items[0].status).toBe('done')
  })

  it('enqueue dedupes by key and marks posts without an original as failed', async () => {
    const queue = useImportQueue({ api: fakeApi(), inLibrary: notInLibrary() })
    const added = queue.enqueue([
      remotePost('danbooru', 1),
      remotePost('danbooru', 1),
      remotePost('sankaku', 'xY', { fileUrl: null, unavailable: 'hidden' }),
      remotePost('e621', 2, { fileUrl: null, unavailable: 'deleted' }),
      { id: 'no-key' },
    ])
    expect(added).toHaveLength(3)
    expect(queue.items.map((item) => [item.key, item.status])).toEqual([
      ['danbooru:1', 'queued'],
      ['sankaku:xY', 'failed'],
      ['e621:2', 'failed'],
    ])
    expect(queue.items[0]).toEqual({
      key: 'danbooru:1',
      post: expect.any(Object),
      status: 'queued',
      message: 'Waiting',
      postId: null,
      duplicate: false,
      attempt: 0,
    })
    expect(queue.items[1].message).toBe('No original file · hidden from logged-out visitors')
    expect(queue.items[2].message).toBe('No original file · deleted on the site')

    queue.enqueue([remotePost('danbooru', 1)])
    expect(queue.items).toHaveLength(3)
    expect(queue.progress.value).toEqual({ done: 0, total: 3, failed: 2, skipped: 0 })

    queue.clearFinished()
    expect(queue.items.map((item) => item.key)).toEqual(['danbooru:1'])
  })

  it('a finished post can be queued again, and start() while running is a no-op', async () => {
    const pending = deferred()
    const api = fakeApi({ fetchFromUrl: vi.fn(() => pending.promise) })
    const inLibrary = { lookupNow: vi.fn(async () => null) }
    const queue = useImportQueue({ api, inLibrary })
    queue.enqueue([remotePost('danbooru', 1)])
    const run = queue.start()
    expect(queue.start()).toBe(run)
    await settle()
    pending.resolve({ token: 't' })
    await run
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)

    inLibrary.lookupNow.mockResolvedValueOnce({ postId: 100 })
    queue.enqueue([remotePost('danbooru', 1)])
    expect(queue.items).toHaveLength(1)
    await queue.start()
    expect(queue.items[0]).toMatchObject({ status: 'skipped', postId: 100 })
  })

  it('refreshes each post through its adapter right before downloading', async () => {
    const api = fakeApi()
    const adapters = {
      sankaku: {
        refresh: vi.fn(async (post) => ({ ...post, fileUrl: `https://fresh.example/${post.id}.png?token=new` })),
      },
      danbooru: {
        refresh: vi.fn(async () => { throw Object.assign(new Error('Danbooru hid this original'), { kind: 'unavailable' }) }),
      },
    }
    const queue = useImportQueue({ api, adapters, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('sankaku', 'aB1'), remotePost('danbooru', 2), remotePost('e621', 3)])
    const run = queue.start()
    await vi.advanceTimersByTimeAsync(5000)
    await run

    expect(adapters.sankaku.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'sankaku:aB1' }),
      { signal: expect.any(AbortSignal), api },
    )
    expect(api.fetchFromUrl.mock.calls[0][0].url).toBe('https://fresh.example/aB1.png?token=new')
    expect(queue.items[1]).toMatchObject({ status: 'failed', message: 'Danbooru hid this original' })
    // No adapter for e621 here: the post is used as it is.
    expect(queue.items[2].status).toBe('done')
    expect(api.fetchFromUrl.mock.calls[1][0].url).toBe('https://cdn.e621.example/original/3.png')
  })

  it('shows download progress while the backend fetches the original', async () => {
    const pending = deferred()
    const api = fakeApi({
      fetchFromUrl: vi.fn(() => pending.promise),
      getFromUrlProgress: vi.fn(async () => ({ received: 12897485, total: 37748736, done: false })),
    })
    const queue = useImportQueue({ api, inLibrary: notInLibrary() })
    queue.enqueue([remotePost('danbooru', 1)])
    const run = queue.start()
    await settle()
    const progressId = api.fetchFromUrl.mock.calls[0][0].progressId
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.getFromUrlProgress).toHaveBeenCalledWith(progressId)
    expect(queue.items[0].message).toBe('Downloading original… 12.3 / 36.0 MB (34%) · 12595 KB/s · 1s')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.getFromUrlProgress).toHaveBeenCalledTimes(2)
    pending.resolve({ token: 't' })
    await run
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.getFromUrlProgress).toHaveBeenCalledTimes(2)
  })

  it('treats a failed library lookup as not found', async () => {
    const api = fakeApi()
    const inLibrary = { lookupNow: vi.fn(async () => { throw new Error('offline') }) }
    const queue = useImportQueue({ api, inLibrary })
    queue.enqueue([remotePost('danbooru', 1)])
    await queue.start()
    expect(queue.items[0].status).toBe('done')
  })
})

describe('import helpers', () => {
  it('downloadProgressText matches the extension format', () => {
    expect(downloadProgressText({ received: 0, total: 0 }, 0)).toBe('Downloading original… 0.0 MB · 0s')
    expect(downloadProgressText({ received: 12897485, total: 37748736 }, 70000))
      .toBe('Downloading original… 12.3 / 36.0 MB (34%) · 180 KB/s · 70s')
  })
})
