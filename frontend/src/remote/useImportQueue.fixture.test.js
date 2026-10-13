import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api/request.js'
import { normalizeTagName } from '../utils/booruSearchTag'
import { booruDisplayNames } from './types.js'
import { DOWNLOAD_GAP_MS, PROGRESS_POLL_MS, RETRY_DELAYS_MS, downloadProgressText, useImportQueue } from './useImportQueue'

// The shared cases in browser-extension/booru-import-rules.fixture.json, run
// through the whole import queue. The extension's import page runs the same
// file in browser-extension/site-import.test.js, so the two cannot drift.
const fixture = JSON.parse(readFileSync(new URL('../../../browser-extension/booru-import-rules.fixture.json', import.meta.url), 'utf8'))

function remotePost(postId, imported = {}) {
  return {
    key: `danbooru:${postId}`,
    site: 'danbooru',
    id: postId,
    postUrl: imported.source ?? `https://danbooru.donmai.us/posts/${postId}`,
    fileUrl: `https://cdn.donmai.test/original/${postId}.png`,
    referer: 'https://danbooru.donmai.us/',
    safety: imported.safety || 'safe',
    tags: imported.tags || [`danbooru_${postId}`],
    tagCategories: imported.tagCategories || { [`danbooru_${postId}`]: 'meta' },
    tagDisplayNames: imported.tagDisplayNames || {},
    unavailable: null,
  }
}

function fakeApi(overrides = {}) {
  return {
    fetchFromUrl: vi.fn(async () => ({ token: 'tok' })),
    getFromUrlProgress: vi.fn(async () => ({ received: 0, total: 0 })),
    createPost: vi.fn(async () => ({ id: 100 })),
    getPost: vi.fn(async (id) => ({ id, tags: [], safety: 'safe', source: '' })),
    updatePost: vi.fn(async (id, body) => ({ id, ...body })),
    restorePost: vi.fn(),
    gelbooruTagCategories: vi.fn(async () => ({ categories: {} })),
    danbooruNames: vi.fn(async () => ({ renames: {} })),
    createAlias: vi.fn(async () => ({})),
    ...overrides,
  }
}

// Runs the queue to the end. Returns the waits it scheduled (download
// progress polls aside) and the item's message when each one started.
async function drain(queue) {
  const realSetTimeout = globalThis.setTimeout
  const sleeps = []
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (ms !== PROGRESS_POLL_MS) {
      sleeps.push({ ms, message: queue.items.find((item) => item.status === 'retrying')?.message || null })
    }
    return realSetTimeout(callback, ms, ...args)
  })
  try {
    const run = queue.start()
    await vi.runAllTimersAsync()
    await run
  } finally {
    spy.mockRestore()
  }
  return sleeps
}

describe('booru import rules shared fixture', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pacing and back-off constants', () => {
    expect(DOWNLOAD_GAP_MS).toBe(fixture.pacing.downloadGapMs)
    expect(RETRY_DELAYS_MS).toEqual(fixture.pacing.retryDelaysMs)
  })

  it('download progress text', () => {
    for (const entry of fixture.progressText) {
      expect(downloadProgressText(entry.progress, entry.elapsedMs)).toBe(entry.expected)
    }
  })

  it('tag display names', () => {
    for (const entry of fixture.displayNames) {
      const names = booruDisplayNames([entry.tag])
      expect(names, entry.tag).toEqual(entry.display === null ? {} : { [normalizeTagName(entry.tag)]: entry.display })
    }
  })

  for (const entry of fixture.postBody) {
    it(`post body: ${entry.name}`, async () => {
      const api = fakeApi({ fetchFromUrl: vi.fn(async () => ({ token: entry.contentToken })) })
      const queue = useImportQueue({ api })
      queue.enqueue([remotePost(entry.postId, entry.import)])
      await drain(queue)
      expect(api.createPost).toHaveBeenCalledTimes(1)
      expect(api.createPost.mock.calls[0][0]).toEqual({ ...entry.expected, autoTag: false, autoTagProfile: 'booru_search' })
    })
  }

  for (const entry of fixture.merge) {
    it(`merge: ${entry.name}`, async () => {
      const detail = { code: 'duplicate_post', ...entry.duplicate }
      const api = fakeApi({
        createPost: vi.fn(async () => { throw new ApiError('duplicate', { kind: 'http', status: 409, detail }) }),
        restorePost: vi.fn(async () => entry.restored),
      })
      const queue = useImportQueue({ api })
      queue.enqueue([remotePost(entry.postId, entry.import)])
      await drain(queue)
      expect(api.restorePost.mock.calls).toEqual(entry.restored ? [[entry.duplicate.postId]] : [])
      expect(api.updatePost).toHaveBeenCalledTimes(1)
      expect(api.updatePost.mock.calls[0]).toEqual([entry.duplicate.postId, entry.expected])
      expect(queue.items[0].status).toBe('done')
    })
  }

  for (const entry of fixture.pacingRuns) {
    it(`pacing: ${entry.name}`, async () => {
      const inLibrary = new Set(entry.posts.filter((post) => post.inLibrary).map((post) => `danbooru:${post.postId}`))
      const api = fakeApi()
      const queue = useImportQueue({
        api,
        inLibrary: { lookupNow: vi.fn(async (key) => (inLibrary.has(key) ? { postId: 50 } : null)) },
      })
      queue.enqueue(entry.posts.map((post) => remotePost(post.postId)))
      const sleeps = await drain(queue)
      expect(sleeps.map((sleep) => sleep.ms)).toEqual(entry.expectedSleepsMs)
      expect(api.fetchFromUrl).toHaveBeenCalledTimes(entry.posts.length - inLibrary.size)
      expect(queue.items.map((item) => (item.status === 'skipped' ? 'done' : item.status))).toEqual(entry.posts.map(() => 'done'))
    })
  }

  for (const entry of fixture.throttle) {
    it(`throttle: ${entry.name}`, async () => {
      let calls = 0
      const api = fakeApi({
        fetchFromUrl: vi.fn(async () => {
          const failure = entry.failures[calls++]
          if (failure) throw new Error(failure)
          return { token: 'tok' }
        }),
      })
      const queue = useImportQueue({ api })
      queue.enqueue([remotePost('21')])
      const sleeps = await drain(queue)
      expect(sleeps.map((sleep) => sleep.ms)).toEqual(entry.expectedSleepsMs)
      expect(sleeps.map((sleep) => sleep.message)).toEqual(entry.expectedRetryTexts)
      expect(queue.items[0].status).toBe(entry.outcome === 'imported' ? 'done' : 'failed')
      if (entry.finalMessage) expect(queue.items[0].message).toBe(entry.finalMessage)
    })
  }

  for (const entry of fixture.throttleHints) {
    it(`throttle hint: ${entry.name}`, async () => {
      let calls = 0
      const api = fakeApi({
        fetchFromUrl: vi.fn(async () => {
          calls += 1
          if (calls <= entry.attempt) throw new Error('HTTP 429')
          if (calls === entry.attempt + 1) throw Object.assign(new Error(entry.error.message), entry.error)
          return { token: 'tok' }
        }),
      })
      const queue = useImportQueue({ api })
      queue.enqueue([remotePost('31')])
      const sleeps = await drain(queue)
      if (entry.expectedMs === null) {
        expect(sleeps).toHaveLength(entry.attempt)
        expect(queue.items[0].status).toBe('failed')
      } else {
        expect(sleeps[entry.attempt].ms).toBe(entry.expectedMs)
        expect(queue.items[0].status).toBe('done')
      }
    })
  }
})
