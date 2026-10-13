import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isReactive } from 'vue'
import { CHUNK_SIZE, COALESCE_MS, RETRY_DELAY_MS, createInLibraryLookup } from './inLibrary.js'

function fakeApi(foundIds = {}) {
  return {
    lookupInLibrary: vi.fn(async (keys) => ({
      found: Object.fromEntries(keys.filter((key) => key in foundIds).map((key) => [key, { postId: foundIds[key] }])),
    })),
  }
}

describe('createInLibraryLookup', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces keys arriving within the window into one request', async () => {
    const api = fakeApi({ 'danbooru:1': 42 })
    const lookup = createInLibraryLookup(api)
    expect(isReactive(lookup.found)).toBe(true)
    const first = lookup.lookup(['danbooru:1', 'danbooru:2'])
    await vi.advanceTimersByTimeAsync(COALESCE_MS - 50)
    const second = lookup.lookup(['e621:3', 'danbooru:1'])
    expect(api.lookupInLibrary).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    await Promise.all([first, second])
    expect(api.lookupInLibrary).toHaveBeenCalledTimes(1)
    expect(api.lookupInLibrary).toHaveBeenCalledWith(['danbooru:1', 'danbooru:2', 'e621:3'])
    expect(lookup.found.get('danbooru:1')).toEqual({ postId: 42 })
    expect(lookup.found.has('danbooru:2')).toBe(false)
  })

  it('skips keys already asked, invalid keys and library keys', async () => {
    const api = fakeApi()
    const lookup = createInLibraryLookup(api)
    const done = lookup.lookup(['danbooru:1'])
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    await done
    await lookup.lookup(['danbooru:1', 'nekobooru:5', 'nonsense', null])
    expect(api.lookupInLibrary).toHaveBeenCalledTimes(1)
  })

  it(`posts chunks of at most ${CHUNK_SIZE} keys`, async () => {
    const api = fakeApi()
    const lookup = createInLibraryLookup(api)
    const keys = Array.from({ length: 450 }, (_, index) => `gelbooru:${index + 1}`)
    const done = lookup.lookup(keys)
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    await done
    expect(api.lookupInLibrary.mock.calls.map(([chunk]) => chunk.length)).toEqual([200, 200, 50])
  })

  it('retries a failed request once after 2 s, then drops it', async () => {
    const api = { lookupInLibrary: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ found: { 'sankaku:aB1': { postId: 7 } } }) }
    const lookup = createInLibraryLookup(api)
    const done = lookup.lookup(['sankaku:aB1'])
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(api.lookupInLibrary).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    await done
    expect(api.lookupInLibrary).toHaveBeenCalledTimes(2)
    expect(lookup.found.get('sankaku:aB1')).toEqual({ postId: 7 })

    const failing = { lookupInLibrary: vi.fn().mockRejectedValue(new Error('down')) }
    const dropped = createInLibraryLookup(failing)
    const settled = dropped.lookup(['danbooru:9'])
    await vi.advanceTimersByTimeAsync(COALESCE_MS + RETRY_DELAY_MS)
    await expect(settled).resolves.toBeUndefined()
    expect(failing.lookupInLibrary).toHaveBeenCalledTimes(2)
    // Dropped keys may be asked again by a later page.
    const again = dropped.lookup(['danbooru:9'])
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(failing.lookupInLibrary).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    await again
  })

  it('lookupNow asks at once, bypassing the cache of negative answers', async () => {
    const api = fakeApi({ 'danbooru:1': 42 })
    const lookup = createInLibraryLookup(api)
    await expect(lookup.lookupNow('danbooru:1')).resolves.toEqual({ postId: 42 })
    await expect(lookup.lookupNow('danbooru:2')).resolves.toBeNull()
    expect(api.lookupInLibrary).toHaveBeenCalledTimes(2)
    expect(api.lookupInLibrary).toHaveBeenLastCalledWith(['danbooru:2'])
    await expect(lookup.lookupNow('nekobooru:2')).resolves.toBeNull()
    const broken = createInLibraryLookup({ lookupInLibrary: vi.fn().mockRejectedValue(new Error('x')) })
    await expect(broken.lookupNow('danbooru:1')).rejects.toThrow('x')
  })

  it('mark() records an import and stops later lookups of that key', async () => {
    const api = fakeApi()
    const lookup = createInLibraryLookup(api)
    lookup.mark('e621:5', 99)
    lookup.mark('e621:6', 0)
    expect(lookup.found.get('e621:5')).toEqual({ postId: 99 })
    expect(lookup.found.has('e621:6')).toBe(false)
    await lookup.lookup(['e621:5'])
    expect(api.lookupInLibrary).not.toHaveBeenCalled()
  })

  it('dispose() cancels the pending batch and settles waiters', async () => {
    const api = fakeApi()
    const lookup = createInLibraryLookup(api)
    const pending = lookup.lookup(['danbooru:1'])
    lookup.dispose()
    await expect(pending).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2)
    expect(api.lookupInLibrary).not.toHaveBeenCalled()
  })
})
