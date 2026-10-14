import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { ADAPTERS, adapterFor } from './adapters/index.js'
import { createBudget } from './budget.js'
import { RemoteSearchError, SITES } from './types.js'
import { MAX_THROTTLE_RETRIES, SEARCH_DEBOUNCE_MS, useRemoteResults } from './useRemoteResults.js'

const ALL = { safety: { safe: true, sketchy: true, unsafe: true }, sort: 'date', order: 'desc' }

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// A fake adapter whose search() calls stay pending until the test settles them.
function fakeAdapter(site, extra = {}) {
  const calls = []
  return {
    id: site,
    calls,
    translate: vi.fn(() => ({ ignored: [], note: null })),
    search: vi.fn((args) => {
      const pending = deferred()
      calls.push({ args, ...pending })
      return pending.promise
    }),
    ...extra,
  }
}

function post(site, id, safety = 'safe') {
  return { key: `${site}:${id}`, site, id: String(id), safety, fileUrl: `https://cdn.example/${id}.png` }
}

function page(site, ids, extra = {}) {
  return { posts: ids.map((id) => post(site, id)), nextCursor: { page: 2 }, total: null, ignoredTerms: [], note: null, ...extra }
}

function fakeLookup() {
  const found = reactive(new Map())
  return {
    found,
    lookup: vi.fn(async () => {}),
    mark: vi.fn((key, postId) => found.set(key, { postId })),
    dispose: vi.fn(),
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

function setup(sites = ['danbooru', 'gelbooru'], options = {}) {
  const adapters = Object.fromEntries(sites.map((site) => [site, fakeAdapter(site, options.extra?.[site])]))
  const lookupInLibrary = options.lookup || fakeLookup()
  const api = options.api || {}
  const results = useRemoteResults({ adapters, api, lookupInLibrary, budgets: options.budgets || {} })
  return { adapters, lookupInLibrary, api, results }
}

describe('adapter registry', () => {
  it('has one frozen adapter per site', () => {
    expect(Object.isFrozen(ADAPTERS)).toBe(true)
    expect(Object.keys(ADAPTERS)).toEqual(SITES.map((site) => site.id))
    for (const site of SITES) expect(adapterFor(site.id).id).toBe(site.id)
    expect(adapterFor('pixiv')).toBeNull()
    expect(adapterFor('toString')).toBeNull()
  })
})

describe('useRemoteResults', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('searches every booru for a library tag under its booru spelling, keeping operators and meta terms', async () => {
    // The library stores yui_(angel_beats!) flattened as yui_angel_beats; the
    // booru spelling survives only in the tag's display name.
    const getTag = vi.fn(async (name) => {
      if (name === 'yui_angel_beats') return { name, displayName: 'yui (angel beats!)' }
      if (name === 'miyu_blue_archive') return { name, displayName: 'miyu (blue archive)' }
      throw Object.assign(new Error('not found'), { status: 404 })
    })
    const { adapters, results } = setup(['danbooru', 'gelbooru'], { api: { getTag } })
    results.search({ query: 'yui_angel_beats -miyu_blue_archive ~solo rating:s', options: ALL, sites: ['danbooru', 'gelbooru'] })
    await settle()
    for (const site of ['danbooru', 'gelbooru']) {
      expect(adapters[site].calls[0].args.query).toBe('yui_(angel_beats!) -miyu_(blue_archive) ~solo rating:s')
    }
    // One lookup per term, shared by every booru; meta terms are never looked up.
    expect(getTag.mock.calls.map(([name]) => name).sort()).toEqual(['miyu_blue_archive', 'solo', 'yui_angel_beats'])
  })

  it(`scheduleSearch debounces ${SEARCH_DEBOUNCE_MS} ms and keeps the latest arguments`, async () => {
    const { adapters, results } = setup(['danbooru'])
    results.scheduleSearch({ query: 'c', options: ALL, sites: ['danbooru'] })
    await vi.advanceTimersByTimeAsync(300)
    results.scheduleSearch({ query: 'cat', options: ALL, sites: ['danbooru'] })
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1)
    expect(adapters.danbooru.search).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(1)
    expect(adapters.danbooru.calls[0].args.query).toBe('cat')
  })

  it('fans out to every ticked remote site at once, in SOURCE_IDS order', () => {
    const { adapters, api, results } = setup(['danbooru', 'e621', 'gelbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['gelbooru', 'nekobooru', 'danbooru'], limit: 60 })
    expect(results.order.value).toEqual(['danbooru', 'gelbooru'])
    expect(adapters.e621.search).not.toHaveBeenCalled()
    for (const site of ['danbooru', 'gelbooru']) {
      const { args } = adapters[site].calls[0]
      expect(args).toMatchObject({ query: 'cat', cursor: null, api, limit: 60 })
      expect(args.signal).toBeInstanceOf(AbortSignal)
      expect(results.sections[site]).toMatchObject({ loading: true, page: 0, limit: 60 })
    }
    expect(results.anyLoading.value).toBe(true)
    expect(results.libraryTicked.value).toBe(true)
  })

  it("uses each site's own page size for 'Default' and caps a number at the site's max", () => {
    const { results } = setup(['danbooru', 'gelbooru'])
    results.search({ query: '', options: ALL, sites: ['danbooru', 'gelbooru'], limit: 'default' })
    expect(results.sections.danbooru.limit).toBe(20)
    expect(results.sections.gelbooru.limit).toBe(42)
    results.search({ query: '', options: ALL, sites: ['danbooru', 'gelbooru'], limit: 500 })
    expect(results.sections.danbooru.limit).toBe(200)
    expect(results.sections.gelbooru.limit).toBe(100)
  })

  it('shows the translation notes before results arrive', () => {
    const { adapters, results } = setup(['danbooru'])
    adapters.danbooru.translate.mockReturnValue({ ignored: ['fox'], note: 'Danbooru allows 2' })
    results.search({ query: 'a b fox', options: ALL, sites: ['danbooru'] })
    expect(results.sections.danbooru).toMatchObject({ ignoredTerms: ['fox'], note: 'Danbooru allows 2' })
  })

  it('aborts a superseded search and discards its late answer', async () => {
    const { adapters, results } = setup(['danbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    const first = adapters.danbooru.calls[0]
    results.search({ query: 'dog', options: ALL, sites: ['danbooru'] })
    expect(first.args.signal.aborted).toBe(true)
    first.resolve(page('danbooru', [1, 2]))
    await settle()
    expect(results.sections.danbooru.posts).toEqual([])
    adapters.danbooru.calls[1].resolve(page('danbooru', [3]))
    await settle()
    expect(results.sections.danbooru.posts.map((p) => p.id)).toEqual(['3'])
  })

  it('re-runs an identical query only for newly ticked sites and drops unticked ones', async () => {
    const { adapters, results } = setup(['danbooru', 'gelbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    await settle()
    results.search({ query: 'cat', options: ALL, sites: ['danbooru', 'gelbooru'] })
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(1)
    expect(adapters.gelbooru.search).toHaveBeenCalledTimes(1)
    expect(results.postByKey('danbooru:1')).toMatchObject({ id: '1' })

    const gelbooruSignal = adapters.gelbooru.calls[0].args.signal
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    expect(gelbooruSignal.aborted).toBe(true)
    expect(results.sections.gelbooru).toBeUndefined()
    expect(results.order.value).toEqual(['danbooru'])
  })

  it('dedupes within a page and applies the rating filter without fetching on', async () => {
    const { adapters, results } = setup(['danbooru'])
    const options = { ...ALL, safety: { safe: true, sketchy: true, unsafe: false } }
    results.search({ query: '', options, sites: ['danbooru'] })
    adapters.danbooru.calls[0].resolve({ ...page('danbooru', [1, 1, 2]), posts: [post('danbooru', 1), post('danbooru', 1), post('danbooru', 2, 'unsafe')] })
    await settle()
    expect(results.sections.danbooru).toMatchObject({ fetched: 2, ratingFiltered: 1, page: 1 })
    expect(results.sections.danbooru.posts.map((p) => p.key)).toEqual(['danbooru:1'])

    // A page whose posts are all filtered out does not trigger another request.
    results.goToPage('danbooru', 2)
    adapters.danbooru.calls[1].resolve({ ...page('danbooru', []), posts: [post('danbooru', 3, 'unsafe')] })
    await settle()
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(2)
    expect(results.sections.danbooru).toMatchObject({ page: 2, fetched: 1, ratingFiltered: 1, cursor: { page: 2 }, exhausted: false })
    expect(results.sections.danbooru.posts).toEqual([])
  })

  it('interleaves round-robin and hides library posts only when NekoBooru is ticked', async () => {
    const { adapters, lookupInLibrary, results } = setup(['danbooru', 'gelbooru'])
    const run = async (sites, hiddenKeys) => {
      results.search({ query: `q${sites.length}`, options: ALL, sites, hiddenKeys })
      adapters.danbooru.calls.at(-1).resolve(page('danbooru', [1, 2, 3]))
      adapters.gelbooru.calls.at(-1).resolve(page('gelbooru', [7]))
      await settle()
    }
    await run(['danbooru', 'gelbooru'])
    expect(results.interleaved.value.map((p) => p.key)).toEqual(['danbooru:1', 'gelbooru:7', 'danbooru:2', 'danbooru:3'])

    lookupInLibrary.found.set('danbooru:2', { postId: 5 })
    expect(results.interleaved.value).toHaveLength(4)
    await run(['nekobooru', 'danbooru', 'gelbooru'], new Set(['gelbooru:7']))
    expect(results.interleaved.value.map((p) => p.key)).toEqual(['danbooru:1', 'danbooru:3'])
    expect(results.inLibrary.get('danbooru:2')).toEqual({ postId: 5 })
  })

  it('pages by replacing posts, serves visited pages from the cache, and steps every section', async () => {
    const { adapters, results } = setup(['danbooru', 'gelbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['danbooru', 'gelbooru'] })
    expect(results.goToPage('danbooru', 2)).toBe(false) // still loading page 1
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    adapters.gelbooru.calls[0].resolve(page('gelbooru', [1], { nextCursor: null }))
    await settle()
    expect(results.sections.danbooru).toMatchObject({ page: 1, hasPrev: false, hasNext: true })
    expect(results.sections.gelbooru).toMatchObject({ page: 1, exhausted: true, hasPrev: false, hasNext: false, totalPages: 1 })

    expect(results.goToPage('danbooru', 2)).toBe(true)
    expect(results.goToPage('gelbooru', 2)).toBe(false) // exhausted on page 1
    expect(adapters.gelbooru.search).toHaveBeenCalledTimes(1)
    expect(adapters.danbooru.calls[1].args.cursor).toEqual({ page: 2 })
    adapters.danbooru.calls[1].resolve(page('danbooru', [2], { nextCursor: null }))
    await settle()
    expect(results.sections.danbooru).toMatchObject({ page: 2, exhausted: true, cursor: null, hasPrev: true, hasNext: false, totalPages: 2 })
    expect(results.sections.danbooru.posts.map((p) => p.id)).toEqual(['2'])
    expect(results.goToPage('danbooru', 3)).toBe(false)

    // Back to page 1 without a request; page 2's posts still resolve by key.
    expect(results.goToPage('danbooru', 1)).toBe(true)
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(2)
    expect(results.sections.danbooru).toMatchObject({ page: 1, hasPrev: false, hasNext: true })
    expect(results.sections.danbooru.posts.map((p) => p.id)).toEqual(['1'])
    expect(results.postByKey('danbooru:2')).toMatchObject({ id: '2' })
    expect(results.goToPage('danbooru', 0)).toBe(false)
  })

  it('jumps straight to a page on a numbered booru, within the page cap', async () => {
    const numbered = { pageCursor: (n) => ({ page: n }), pageCap: () => 10 }
    const { adapters, results } = setup(['danbooru'], { extra: { danbooru: numbered } })
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'], limit: 20 })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1], { total: 1000 }))
    await settle()
    expect(results.sections.danbooru).toMatchObject({ canJump: true, totalPages: 10 })

    expect(results.goToPage('danbooru', 11)).toBe(false)
    expect(results.goToPage('danbooru', 7)).toBe(true)
    expect(adapters.danbooru.calls[1].args.cursor).toEqual({ page: 7 })
    adapters.danbooru.calls[1].resolve(page('danbooru', [70], { nextCursor: { page: 8 } }))
    await settle()
    expect(results.sections.danbooru).toMatchObject({ page: 7, hasPrev: true, hasNext: true })
    expect(results.goToPage('danbooru', 6)).toBe(true)
    expect(adapters.danbooru.calls[2].args.cursor).toEqual({ page: 6 })
  })

  it('walks a cursor-only booru one visited page at a time', async () => {
    const { adapters, results } = setup(['sankaku'])
    results.search({ query: 'cat', options: ALL, sites: ['sankaku'] })
    adapters.sankaku.calls[0].resolve(page('sankaku', ['a'], { nextCursor: 'k2' }))
    await settle()
    expect(results.sections.sankaku.canJump).toBe(false)
    expect(results.goToPage('sankaku', 3)).toBe(false) // no cursor for page 3 yet
    expect(results.goToPage('sankaku', 2)).toBe(true)
    expect(adapters.sankaku.calls[1].args.cursor).toBe('k2')
    adapters.sankaku.calls[1].resolve(page('sankaku', ['b'], { nextCursor: 'k3' }))
    await settle()
    expect(results.goToPage('sankaku', 1)).toBe(true)
    expect(results.goToPage('sankaku', 3)).toBe(true) // its cursor is known now
    expect(adapters.sankaku.calls[2].args.cursor).toBe('k3')
  })

  it('hands every page of new keys to the in-library lookup and marks imports', async () => {
    const { adapters, lookupInLibrary, results } = setup(['danbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1, 2]))
    await settle()
    expect(lookupInLibrary.lookup).toHaveBeenCalledWith(['danbooru:1', 'danbooru:2'])
    results.markImported('danbooru:1', 77)
    expect(lookupInLibrary.mark).toHaveBeenCalledWith('danbooru:1', 77)
    expect(results.inLibrary.get('danbooru:1')).toEqual({ postId: 77 })
  })

  it('coalesces the in-library requests of every section through the default lookup', async () => {
    const api = { lookupInLibrary: vi.fn(async () => ({ found: { 'gelbooru:7': { postId: 3 } } })) }
    const adapters = { danbooru: fakeAdapter('danbooru'), gelbooru: fakeAdapter('gelbooru') }
    const results = useRemoteResults({ adapters, api })
    results.search({ query: 'cat', options: ALL, sites: ['danbooru', 'gelbooru'] })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    await vi.advanceTimersByTimeAsync(100)
    adapters.gelbooru.calls[0].resolve(page('gelbooru', [7]))
    await vi.advanceTimersByTimeAsync(100)
    expect(api.lookupInLibrary).toHaveBeenCalledTimes(1)
    expect(api.lookupInLibrary).toHaveBeenCalledWith(['danbooru:1', 'gelbooru:7'])
    expect(results.inLibrary.get('gelbooru:7')).toEqual({ postId: 3 })
    results.dispose()
  })

  it('defers a request the budget cannot afford and counts the wait down', async () => {
    const budgets = { danbooru: createBudget({ burst: 1, perSecond: 0.5 }) }
    const { adapters, results } = setup(['danbooru'], { budgets })
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    await settle()
    expect(results.goToPage('danbooru', 2)).toBe(true)
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(1)
    expect(results.sections.danbooru).toMatchObject({ loading: true, waitingMs: 2000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(results.sections.danbooru.waitingMs).toBe(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(2)
    expect(adapters.danbooru.calls[1].args.cursor).toEqual({ page: 2 })
    expect(results.sections.danbooru.waitingMs).toBe(0)
  })

  it('cools a throttled site down for Retry-After, retries by itself, then waits for Retry', async () => {
    const { adapters, results } = setup(['danbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    const throttled = () => new RemoteSearchError({ site: 'danbooru', status: 429, kind: 'throttled', retryAfterMs: 5000 })
    adapters.danbooru.calls[0].reject(throttled())
    await settle()
    expect(results.sections.danbooru.error.kind).toBe('throttled')
    expect(results.sections.danbooru.waitingMs).toBe(5000)
    await vi.advanceTimersByTimeAsync(4999)
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(2)
    expect(adapters.danbooru.calls[1].args.cursor).toBeNull()

    for (let attempt = 1; attempt <= MAX_THROTTLE_RETRIES; attempt += 1) {
      adapters.danbooru.calls.at(-1).reject(throttled())
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(MAX_THROTTLE_RETRIES + 1)
    expect(results.sections.danbooru).toMatchObject({ loading: false, waitingMs: 0 })

    expect(results.retry('danbooru')).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(MAX_THROTTLE_RETRIES + 2)
    adapters.danbooru.calls.at(-1).resolve(page('danbooru', [1]))
    await settle()
    expect(results.sections.danbooru).toMatchObject({ error: null, page: 1 })
  })

  it('shows other failures and re-runs the failed page on retry()', async () => {
    const { adapters, results } = setup(['danbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    expect(results.retry('danbooru')).toBe(false)
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    await settle()
    results.goToPage('danbooru', 2)
    adapters.danbooru.calls[1].reject(new Error('boom'))
    await settle()
    expect(results.sections.danbooru.error).toBeInstanceOf(RemoteSearchError)
    expect(results.sections.danbooru.error).toMatchObject({ kind: 'upstream', message: 'boom' })
    expect(results.retry('danbooru')).toBe(true)
    expect(adapters.danbooru.calls[2].args.cursor).toEqual({ page: 2 })
    expect(results.sections.danbooru.error).toBeNull()
  })

  it('dispose() aborts everything', () => {
    const { adapters, lookupInLibrary, results } = setup(['danbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    results.scheduleSearch({ query: 'dog', options: ALL, sites: ['danbooru'] })
    results.dispose()
    expect(adapters.danbooru.calls[0].args.signal.aborted).toBe(true)
    expect(results.order.value).toEqual([])
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(1)
    expect(lookupInLibrary.dispose).not.toHaveBeenCalled() // injected lookups belong to the caller
  })
})

describe('useRemoteResults per-site ratings', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const noSketchy = { ...ALL, safety: { safe: true, sketchy: false, unsafe: true } }
  const mixed = (site) => ({ ...page(site, []), posts: [post(site, 1), post(site, 2, 'sketchy'), post(site, 3, 'unsafe')] })

  it('translates and requests with the global filter intersected with the site toggles', async () => {
    const { adapters, results } = setup(['e621', 'danbooru'])
    results.search({ query: 'cat', options: noSketchy, sites: ['e621', 'danbooru'], siteSafety: { e621: { safe: true, sketchy: true, unsafe: false } } })
    expect(adapters.e621.translate).toHaveBeenCalledWith('cat', expect.objectContaining({ safety: { safe: true, sketchy: false, unsafe: false } }))
    expect(adapters.e621.calls[0].args.options.safety).toEqual({ safe: true, sketchy: false, unsafe: false })
    expect(adapters.danbooru.calls[0].args.options.safety).toEqual({ safe: true, sketchy: false, unsafe: true })
  })

  it('hides unsafe posts for e621 only, counting them as rating-filtered', async () => {
    const { adapters, results } = setup(['e621', 'danbooru'])
    results.search({ query: '', options: ALL, sites: ['e621', 'danbooru'], siteSafety: { e621: { safe: true, sketchy: true, unsafe: false } } })
    adapters.e621.calls[0].resolve(mixed('e621'))
    adapters.danbooru.calls[0].resolve(mixed('danbooru'))
    await settle()
    expect(results.sections.e621.posts.map((p) => p.key)).toEqual(['e621:1', 'e621:2'])
    expect(results.sections.e621).toMatchObject({ fetched: 3, ratingFiltered: 1 })
    expect(results.sections.danbooru.posts).toHaveLength(3)
    expect(results.sections.danbooru.ratingFiltered).toBe(0)
  })

  it('re-runs only the site whose toggles changed, dropping its page cache', async () => {
    const { adapters, results } = setup(['e621', 'danbooru'], { budgets: { e621: createBudget({ burst: 10 }) } })
    const run = (siteSafety) => results.search({ query: 'cat', options: ALL, sites: ['e621', 'danbooru'], siteSafety })
    run({})
    adapters.e621.calls[0].resolve(page('e621', [1]))
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    await settle()
    results.goToPage('e621', 2)
    adapters.e621.calls[1].resolve(page('e621', [2]))
    await settle()

    run({ e621: { safe: true, sketchy: true, unsafe: false } })
    expect(adapters.danbooru.search).toHaveBeenCalledTimes(1)
    expect(adapters.e621.search).toHaveBeenCalledTimes(3)
    expect(adapters.e621.calls[2].args.cursor).toBeNull()
    expect(results.sections.e621.page).toBe(0)
    run({ e621: { safe: true, sketchy: true, unsafe: false } })
    expect(adapters.e621.search).toHaveBeenCalledTimes(3)
  })
})

describe('useRemoteResults page counts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('takes an exact total from the search response', async () => {
    const { adapters, results } = setup(['gelbooru'])
    results.search({ query: 'cat', options: ALL, sites: ['gelbooru'] })
    adapters.gelbooru.calls[0].resolve(page('gelbooru', [1], { total: 100, totalIsEstimate: false }))
    await settle()
    expect(results.sections.gelbooru).toMatchObject({ page: 1, total: 100, totalPages: 3, totalIsEstimate: false })
  })

  it('asks a counting adapter once per search, not per page', async () => {
    const count = vi.fn(async () => 95)
    const { adapters, results } = setup(['danbooru'], { extra: { danbooru: { count, countIsEstimate: false } } })
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'], limit: 20 })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    await settle()
    expect(count).toHaveBeenCalledTimes(1)
    expect(count.mock.calls[0][0]).toBe('cat')
    expect(count.mock.calls[0][2].signal).toBe(adapters.danbooru.calls[0].args.signal)
    expect(results.sections.danbooru).toMatchObject({ total: 95, totalPages: 5, totalIsEstimate: false })
    results.goToPage('danbooru', 2)
    adapters.danbooru.calls[1].resolve(page('danbooru', [2]))
    await settle()
    expect(count).toHaveBeenCalledTimes(1)
    expect(results.sections.danbooru).toMatchObject({ page: 2, totalPages: 5 })
  })

  it('leaves the total unknown when the count fails or does not apply', async () => {
    const failing = vi.fn(async () => null)
    const skipped = vi.fn(async () => 5)
    const { adapters, results } = setup(['danbooru', 'e621'], {
      extra: { danbooru: { count: failing }, e621: { count: skipped, countable: () => false, countIsEstimate: true } },
    })
    results.search({ query: 'a b', options: ALL, sites: ['danbooru', 'e621'] })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    adapters.e621.calls[0].resolve(page('e621', [1]))
    await settle()
    expect(failing).toHaveBeenCalledTimes(1)
    expect(skipped).not.toHaveBeenCalled()
    expect(results.sections.danbooru).toMatchObject({ total: null, totalPages: null })
    expect(results.sections.e621).toMatchObject({ total: null, totalPages: null })
  })

  it('marks estimates, and makes the count exact once the last page is in', async () => {
    const count = vi.fn(async () => 1000)
    const { adapters, results } = setup(['e621', 'sankaku'], { extra: { e621: { count, countable: () => true, countIsEstimate: true } } })
    results.search({ query: 'cat', options: ALL, sites: ['e621', 'sankaku'], limit: 100 })
    adapters.e621.calls[0].resolve(page('e621', [1]))
    adapters.sankaku.calls[0].resolve(page('sankaku', ['aB1'], { total: 250, totalIsEstimate: true }))
    await settle()
    expect(results.sections.e621).toMatchObject({ total: 1000, totalPages: 10, totalIsEstimate: true })
    expect(results.sections.sankaku).toMatchObject({ total: 250, totalPages: 3, totalIsEstimate: true })

    results.goToPage('sankaku', 2)
    adapters.sankaku.calls[1].resolve(page('sankaku', ['cD2'], { nextCursor: null, total: 250, totalIsEstimate: true }))
    await settle()
    expect(results.sections.sankaku).toMatchObject({ page: 2, totalPages: 2, total: 2, totalIsEstimate: false })
  })

  it('caps the page count at the pages the booru will page to anonymously', async () => {
    const pageCap = vi.fn(() => 4)
    const { adapters, results } = setup(['danbooru'], { extra: { danbooru: { pageCap } } })
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'], limit: 20 })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1], { total: 80000 }))
    await settle()
    expect(pageCap).toHaveBeenCalledWith(20)
    expect(results.sections.danbooru).toMatchObject({ total: 80000, totalPages: 4 })
  })

  it('knows each booru\'s anonymous paging cap', () => {
    expect(ADAPTERS.danbooru.pageCap(20)).toBe(1000)
    expect(ADAPTERS.e621.pageCap(75)).toBe(750)
    expect(ADAPTERS.gelbooru.pageCap(100)).toBe(200) // offsets stop at 20000
    expect(ADAPTERS.gelbooru.pageCap(20)).toBe(500) // the relay's page limit
    expect(ADAPTERS.safebooru.pageCap(42)).toBe(500)
    expect(ADAPTERS.sankaku.pageCap).toBeUndefined() // keyset paging, no page cap
  })

  it('does not let a late count from a superseded search land', async () => {
    const pending = deferred()
    const count = vi.fn(() => pending.promise)
    const { adapters, results } = setup(['danbooru'], { extra: { danbooru: { count } } })
    results.search({ query: 'cat', options: ALL, sites: ['danbooru'] })
    adapters.danbooru.calls[0].resolve(page('danbooru', [1]))
    await settle()
    results.search({ query: 'dog', options: ALL, sites: ['danbooru'] })
    pending.resolve(500)
    await settle()
    expect(results.sections.danbooru.total).toBeNull()
  })
})
