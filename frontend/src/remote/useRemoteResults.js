import { createBooruSpeller } from './booruSpelling.js'
import { computed, markRaw, reactive, ref, shallowRef } from 'vue'
import { ADAPTERS } from './adapters/index.js'
import { createBudget } from './budget.js'
import { createInLibraryLookup } from './inLibrary.js'
import { LIBRARY_SOURCE, RemoteSearchError, SAFETY_ORDER, SOURCE_IDS, effectiveLimit, siteById } from './types.js'

// Remote search results for the home view (section 3.6 of
// docs/booru-search-plan.md): one section per ticked booru, fanned out
// concurrently, each with its own AbortController, request budget, page
// cache and page count. A section shows one page at a time: goToPage()
// replaces its posts. The home view renders `sections` (grouped) or
// `interleaved`.

export const SEARCH_DEBOUNCE_MS = 500
// A 429/503 retries itself after the cooldown this many times, then waits for Retry.
export const MAX_THROTTLE_RETRIES = 3
// e621 enforces 2 requests per second; the other sites get createBudget()'s default.
export const SITE_BUDGETS = { e621: { burst: 2, perSecond: 1 } }
const COUNTDOWN_TICK_MS = 1000

function normalizeOptions(options = {}) {
  const safety = Object.fromEntries(SAFETY_ORDER.map((level) => [level, options.safety?.[level] !== false]))
  return { safety, sort: options.sort || 'date', order: options.order === 'asc' ? 'asc' : 'desc' }
}

function newSection(site, limit, canJump) {
  return {
    site,
    label: siteById(site)?.label || site,
    posts: [],               // the shown page's posts
    cursor: null,            // the booru's cursor for the page after the shown one
    loading: false,
    error: null,
    total: null,             // matching posts on the booru; null = unknown
    totalIsEstimate: false,  // true when `total` (and so totalPages) is an estimate
    page: 0,                 // the shown page, 1-based; 0 before the first arrives
    totalPages: null,        // null = unknown
    hasPrev: false,
    hasNext: false,
    canJump,                 // the booru pages by number (any page), not by cursor only
    limit,                   // posts per request (effectiveLimit)
    ignoredTerms: [],
    note: null,
    exhausted: false,        // the last page has been seen
    waitingMs: 0,            // budget deferral or throttle cooldown still to wait
    fetched: 0,              // posts the booru returned for the shown page
    ratingFiltered: 0,       // of those, dropped by the rating checkboxes
  }
}

// The global options with the safety narrowed to what `site` may show:
// the global filter intersected with the site's own rating toggles.
function optionsFor(site, options, siteSafety) {
  const own = siteSafety?.[site]
  if (!own) return options
  const safety = Object.fromEntries(SAFETY_ORDER.map((level) => [level, options.safety[level] && own[level] !== false]))
  return { ...options, safety }
}

function countOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

// The page count. `rt.pageCap` is the last page the booru pages to
// anonymously (adapter.pageCap), null when it has none: navigation never gets
// past it, so neither may the count.
function updatePages(section, rt) {
  if (rt.lastPage !== null) {
    section.totalPages = rt.lastPage
    // Every page seen: the total is exact too, unless the booru gave one.
    let seenAll = true
    let fetched = 0
    for (let page = 1; page <= rt.lastPage; page += 1) {
      const entry = rt.pages.get(page)
      if (!entry) seenAll = false
      else fetched += entry.fetched
    }
    if (seenAll && (section.total === null || section.totalIsEstimate)) {
      section.total = fetched
      section.totalIsEstimate = false
    }
    return
  }
  if (section.total === null) {
    section.totalPages = null
    return
  }
  const pages = Math.max(rt.furthest, Math.ceil(section.total / Math.max(1, section.limit)))
  section.totalPages = rt.pageCap ? Math.max(rt.furthest, Math.min(pages, rt.pageCap)) : pages
}

/**
 * useRemoteResults({ adapters, api, lookupInLibrary, budgets })
 *
 * `adapters` defaults to the registry; `lookupInLibrary` to a lookup over
 * `api` (pass the same one to useImportQueue as `inLibrary`, or use the
 * returned `lookup`); `budgets` may hold a ready budget per site (tests).
 */
export function useRemoteResults(config = {}) {
  const { adapters = ADAPTERS, api = null, budgets: givenBudgets = {} } = config
  const ownsLookup = !config.lookupInLibrary
  const lookup = config.lookupInLibrary || createInLibraryLookup(api)
  const spell = createBooruSpeller(api)

  const sections = reactive({})
  const activeSites = ref([])
  const libraryTicked = ref(false)
  const hiddenKeys = shallowRef(new Set())
  const inLibrary = lookup.found

  // Per-site bookkeeping that the UI never sees. A reset replaces the whole
  // object, which is how late answers recognise themselves as stale.
  const runtime = new Map()
  const budgets = new Map()
  // Every post of every cached page, so a selection made on another page
  // still resolves (keys are stable across pages).
  const postIndex = new Map()
  let current = { query: '', options: normalizeOptions(), limit: null }
  let lastSignature = null
  let debounceTimer = null

  const order = computed(() => activeSites.value.filter((site) => sections[site]))
  const anyLoading = computed(() => order.value.some((site) => sections[site].loading))

  // Round-robin: the first post of every section, then the second, ... Posts
  // the library already shows are left out when NekoBooru is ticked.
  const interleaved = computed(() => {
    const lists = order.value.map((site) => sections[site].posts)
    const hide = libraryTicked.value
    const hidden = hiddenKeys.value
    const merged = []
    const longest = Math.max(0, ...lists.map((list) => list.length))
    for (let index = 0; index < longest; index += 1) {
      for (const list of lists) {
        const post = list[index]
        if (!post || (hide && (inLibrary.has(post.key) || hidden.has(post.key)))) continue
        merged.push(post)
      }
    }
    return merged
  })

  function budgetFor(site) {
    if (!budgets.has(site)) budgets.set(site, givenBudgets[site] || createBudget(SITE_BUDGETS[site] || {}))
    return budgets.get(site)
  }

  function isStale(site, rt) {
    return runtime.get(site) !== rt || rt.controller.signal.aborted
  }

  function clearTimers(rt) {
    for (const cancel of rt.timers) cancel()
    rt.timers.clear()
  }

  // Run `then` after `ms`, counting `waitingMs` down once a second meanwhile.
  function wait(site, rt, ms, then) {
    clearTimers(rt)
    const section = sections[site]
    const deadline = Date.now() + ms
    section.waitingMs = ms
    const tick = setInterval(() => { section.waitingMs = Math.max(0, deadline - Date.now()) }, COUNTDOWN_TICK_MS)
    const timeout = setTimeout(() => {
      clearInterval(tick)
      rt.timers.delete(cancel)
      section.waitingMs = 0
      if (!isStale(site, rt)) then()
    }, Math.max(0, ms))
    function cancel() {
      clearInterval(tick)
      clearTimeout(timeout)
    }
    rt.timers.add(cancel)
  }

  // One page request, deferred (never dropped) while the budget is empty.
  function request(site, cursor, page) {
    const rt = runtime.get(site)
    const section = sections[site]
    if (!rt || !section) return
    clearTimers(rt)
    section.loading = true
    const budget = budgetFor(site)
    if (!budget.take()) {
      wait(site, rt, Math.max(1, budget.retryInMs()), () => request(site, cursor, page))
      return
    }
    section.waitingMs = 0
    run(site, rt, cursor, page)
  }

  async function run(site, rt, cursor, page) {
    const section = sections[site]
    const context = { ...current, options: rt.options }
    rt.lastCursor = cursor
    rt.lastRequestedPage = page
    rt.inFlight = true
    section.loading = true
    section.error = null
    let result
    try {
      // Library tags go out in their booru spelling (yui_angel_beats ->
      // yui_(angel_beats!)); synchronous when there is nothing to look up.
      const spelled = spell(context.query)
      if (typeof spelled !== 'string') context.query = await spelled
      else context.query = spelled
      if (isStale(site, rt)) return
      result = await adapters[site].search({
        query: context.query,
        options: context.options,
        cursor,
        signal: rt.controller.signal,
        api,
        limit: context.limit,
      })
    } catch (error) {
      if (isStale(site, rt)) return
      rt.inFlight = false
      fail(site, rt, cursor, page, error)
      return
    }
    if (isStale(site, rt)) return
    rt.inFlight = false
    rt.throttleRetries = 0
    section.loading = false
    apply(site, rt, page, result || {})
    if (page === 1 && !rt.counted) {
      rt.counted = true
      startCount(site, rt, context)
    }
  }

  function fail(site, rt, cursor, page, error) {
    const section = sections[site]
    section.loading = false
    if (error?.name === 'AbortError') return
    const failure = error instanceof RemoteSearchError
      ? error
      : new RemoteSearchError({ site, message: error?.message || String(error || ''), kind: 'upstream' })
    section.error = failure
    if (failure.kind !== 'throttled') return
    const budget = budgetFor(site)
    budget.coolDown(failure.retryAfterMs ? failure.retryAfterMs / 1000 : undefined)
    if (rt.throttleRetries >= MAX_THROTTLE_RETRIES) return
    rt.throttleRetries += 1
    section.loading = true
    wait(site, rt, Math.max(1, budget.retryInMs()), () => request(site, cursor, page))
  }

  // Cache an answered page, and show it unless the user has moved on.
  function apply(site, rt, page, result) {
    const section = sections[site]
    // Re-applied here whatever the booru made of the rating terms.
    const safety = rt.options.safety
    const seen = new Set()
    const posts = []
    let fetched = 0
    let ratingFiltered = 0
    for (const post of Array.isArray(result.posts) ? result.posts : []) {
      if (!post?.key || seen.has(post.key)) continue
      seen.add(post.key)
      fetched += 1
      if (safety[post.safety] === false) {
        ratingFiltered += 1
        continue
      }
      const kept = markRaw(post)
      postIndex.set(post.key, kept)
      posts.push(kept)
    }
    const capped = rt.pageCap !== null && page >= rt.pageCap
    const nextCursor = capped ? null : result.nextCursor || null
    rt.pages.set(page, { posts, fetched, ratingFiltered, nextCursor })
    rt.furthest = Math.max(rt.furthest, page)
    if (nextCursor) rt.cursors.set(page + 1, nextCursor)
    else if (rt.lastPage === null || page < rt.lastPage) rt.lastPage = page
    if (Array.isArray(result.ignoredTerms)) section.ignoredTerms = result.ignoredTerms
    if (result.note !== undefined) section.note = result.note ?? null
    const total = countOrNull(result.total)
    if (total !== null && (section.total === null || section.totalIsEstimate || !result.totalIsEstimate)) {
      section.total = total
      section.totalIsEstimate = Boolean(result.totalIsEstimate)
    }
    if (page === rt.wantedPage) show(site, rt, page)
    else updatePages(section, rt)
    if (posts.length) Promise.resolve(lookup.lookup(posts.map((post) => post.key))).catch(() => {})
  }

  function show(site, rt, page) {
    const section = sections[site]
    const entry = rt.pages.get(page)
    if (!entry) return
    section.page = page
    section.posts = entry.posts.slice()
    section.fetched = entry.fetched
    section.ratingFiltered = entry.ratingFiltered
    section.cursor = entry.nextCursor
    section.exhausted = rt.lastPage !== null
    updatePages(section, rt)
    section.hasPrev = page > 1
    section.hasNext = cursorFor(site, rt, page + 1) !== undefined
  }

  // The cursor that fetches `page`: null for the first, the booru's own
  // number for sites that page by number, else the cursor an earlier page
  // handed out. undefined = not reachable (past the end, or not yet known).
  function cursorFor(site, rt, page) {
    if (page < 1 || (rt.lastPage !== null && page > rt.lastPage)) return undefined
    if (rt.pageCap !== null && page > rt.pageCap) return undefined
    if (page === 1) return null
    if (rt.cursors.has(page)) return rt.cursors.get(page)
    const adapter = adapters[site]
    if (typeof adapter?.pageCursor !== 'function') return undefined
    // Numbered paging still stops at a known page count.
    const totalPages = sections[site]?.totalPages
    if (totalPages && page > totalPages) return undefined
    return adapter.pageCursor(page)
  }

  // Once per search, after the first page: the adapter's own count (Danbooru's
  // exact one, e621's per-tag estimate) when the page left the total unknown.
  function startCount(site, rt, context) {
    const adapter = adapters[site]
    const section = sections[site]
    if (typeof adapter?.count !== 'function' || section.total !== null || section.exhausted) return
    if (typeof adapter.countable === 'function' && !adapter.countable(context.query, context.options)) return
    const attempt = () => {
      rt.countTimer = null
      if (isStale(site, rt)) return
      const budget = budgetFor(site)
      if (!budget.take()) {
        rt.countTimer = setTimeout(attempt, Math.max(1, budget.retryInMs()))
        return
      }
      Promise.resolve()
        .then(() => adapter.count(context.query, context.options, { signal: rt.controller.signal, api, limit: context.limit }))
        .then((value) => {
          const total = countOrNull(value)
          if (isStale(site, rt) || total === null || (section.total !== null && !section.totalIsEstimate)) return
          if (section.exhausted) return
          section.total = total
          section.totalIsEstimate = Boolean(adapter.countIsEstimate)
          updatePages(section, rt)
          section.hasNext = cursorFor(site, rt, section.page + 1) !== undefined
        })
        .catch(() => {})
    }
    attempt()
  }

  function removeSection(site) {
    const rt = runtime.get(site)
    if (rt) {
      rt.controller.abort()
      clearTimers(rt)
      if (rt.countTimer) clearTimeout(rt.countTimer)
      runtime.delete(site)
      for (const entry of rt.pages.values()) {
        for (const post of entry.posts) postIndex.delete(post.key)
      }
    }
    delete sections[site]
  }

  function resetSection(site, options) {
    removeSection(site)
    const adapter = adapters[site]
    const limit = effectiveLimit(site, current.limit)
    const cap = Number(adapter.pageCap?.(limit))
    runtime.set(site, {
      controller: new AbortController(),
      timers: new Set(),
      pages: new Map(),        // page -> { posts, fetched, ratingFiltered, nextCursor }
      cursors: new Map(),      // page -> cursor handed out by the page before it
      furthest: 0,             // highest page answered
      lastPage: null,          // the page that had no next cursor
      wantedPage: 1,           // the page the user asked for last
      lastCursor: null,
      lastRequestedPage: 1,
      inFlight: false,
      throttleRetries: 0,
      counted: false,
      countTimer: null,
      pageCap: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null,
      options,                 // the global options with this site's safety
      optionsKey: JSON.stringify(options.safety),
    })
    const section = newSection(site, limit, typeof adapter.pageCursor === 'function')
    // Show what the booru will not understand before its results arrive.
    try {
      const translation = adapter.translate?.(current.query, options)
      if (translation) {
        section.ignoredTerms = translation.ignored || []
        section.note = translation.note ?? null
      }
    } catch {
      // The search itself will report the problem.
    }
    sections[site] = section
  }

  /**
   * search({ query, options, sites, hiddenKeys, limit, siteSafety })
   * Runs at once; scheduleSearch() is the debounced form for a watch.
   * `sites` are ticked SOURCE_IDS (NekoBooru included or not); `limit` is the
   * per-page choice: null/'default' = each booru's own page size, a number =
   * that many everywhere, capped per booru. Re-running the same query only
   * starts newly ticked sites; unticked ones are aborted and removed.
   * `siteSafety` = { [site]: { safe, sketchy, unsafe } } narrows the safety
   * per booru; a change there re-runs (and drops the page cache of) only the
   * sites whose effective safety changed.
   */
  function search({ query = '', options = {}, sites = [], hiddenKeys: hidden = null, limit = null, siteSafety = null } = {}) {
    cancelScheduledSearch()
    const ticked = new Set(sites || [])
    const remote = SOURCE_IDS.filter((site) => site !== LIBRARY_SOURCE && ticked.has(site) && adapters[site])
    libraryTicked.value = ticked.has(LIBRARY_SOURCE)
    hiddenKeys.value = new Set(hidden || [])
    const normalized = normalizeOptions(options)
    const requested = limit === undefined || limit === '' ? null : limit
    const signature = JSON.stringify([String(query ?? '').trim(), normalized, requested ?? 'default'])
    const sameQuery = signature === lastSignature
    lastSignature = signature
    current = { query: String(query ?? '').trim(), options: normalized, limit: requested }

    for (const site of Object.keys(sections)) {
      if (!remote.includes(site)) removeSection(site)
    }
    activeSites.value = remote
    for (const site of remote) {
      const siteOptions = optionsFor(site, normalized, siteSafety)
      if (sameQuery && sections[site] && runtime.get(site)?.optionsKey === JSON.stringify(siteOptions.safety)) continue
      resetSection(site, siteOptions)
      request(site, null, 1)
    }
  }

  function scheduleSearch(args, delayMs = SEARCH_DEBOUNCE_MS) {
    cancelScheduledSearch()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      search(args)
    }, delayMs)
  }

  function cancelScheduledSearch() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = null
  }

  /**
   * goToPage(site, page): show that page of the section, from the cache or
   * with one request. False when the page is out of reach (before 1, past the
   * last or the cap, a cursor-only booru's page not yet reached) or while the
   * section is loading another page.
   */
  function goToPage(site, page) {
    const section = sections[site]
    const rt = runtime.get(site)
    const target = Math.floor(Number(page))
    if (!section || !rt || !Number.isFinite(target)) return false
    if (target === section.page && !section.error) return false
    if (rt.pages.has(target)) {
      if (section.loading) return false
      rt.wantedPage = target
      section.error = null
      show(site, rt, target)
      return true
    }
    if (section.loading) return false
    const cursor = cursorFor(site, rt, target)
    if (cursor === undefined) return false
    rt.wantedPage = target
    request(site, cursor, target)
    return true
  }

  // Re-run the last request of a failed section, skipping any cooldown wait
  // for the budget (which still defers it while the site cools down).
  function retry(site) {
    const section = sections[site]
    const rt = runtime.get(site)
    if (!section || !rt || !section.error || rt.inFlight) return false
    rt.throttleRetries = 0
    rt.wantedPage = rt.lastRequestedPage
    request(site, rt.lastCursor, rt.lastRequestedPage)
    return true
  }

  function postByKey(key) {
    return postIndex.get(key) || null
  }

  function markImported(key, postId) {
    lookup.mark(key, postId)
  }

  function dispose() {
    cancelScheduledSearch()
    for (const site of Object.keys(sections)) removeSection(site)
    activeSites.value = []
    lastSignature = null
    if (ownsLookup) lookup.dispose?.()
  }

  return {
    sections,
    order,
    interleaved,
    inLibrary,
    anyLoading,
    libraryTicked,
    lookup,
    search,
    scheduleSearch,
    cancelScheduledSearch,
    goToPage,
    postByKey,
    markImported,
    retry,
    dispose,
  }
}
