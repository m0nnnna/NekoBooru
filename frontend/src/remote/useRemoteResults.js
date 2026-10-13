import { computed, markRaw, reactive, ref, shallowRef } from 'vue'
import { ADAPTERS } from './adapters/index.js'
import { createBudget } from './budget.js'
import { createInLibraryLookup } from './inLibrary.js'
import { LIBRARY_SOURCE, RemoteSearchError, SAFETY_ORDER, SOURCE_IDS, effectiveLimit, siteById } from './types.js'

// Remote search results for the home view (section 3.6 of
// docs/booru-search-plan.md): one section per ticked booru, fanned out
// concurrently, each with its own AbortController, request budget, cursor and
// page count. The home view renders `sections` (grouped) or `interleaved`.

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

function newSection(site, limit) {
  return {
    site,
    label: siteById(site)?.label || site,
    posts: [],
    cursor: null,
    loading: false,
    error: null,
    total: null,             // matching posts on the booru; null = unknown
    totalIsEstimate: false,  // true when `total` (and so totalPages) is an estimate
    page: 0,                 // pages loaded so far
    totalPages: null,        // null = unknown
    limit,                   // posts per request (effectiveLimit)
    ignoredTerms: [],
    note: null,
    exhausted: false,
    waitingMs: 0,            // budget deferral or throttle cooldown still to wait
    fetched: 0,              // posts the booru returned (deduped)
    ratingFiltered: 0,       // of those, dropped by the rating checkboxes
  }
}

function countOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function updatePages(section) {
  if (section.exhausted) {
    // Everything has been seen: the page count is exact now, and so is the
    // total unless the booru gave an exact one.
    section.totalPages = section.page
    if (section.total === null || section.totalIsEstimate) {
      section.total = section.fetched
      section.totalIsEstimate = false
    }
    return
  }
  section.totalPages = section.total === null
    ? null
    : Math.max(section.page, Math.ceil(section.total / Math.max(1, section.limit)))
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

  const sections = reactive({})
  const activeSites = ref([])
  const libraryTicked = ref(false)
  const hiddenKeys = shallowRef(new Set())
  const inLibrary = lookup.found

  // Per-site bookkeeping that the UI never sees. A reset replaces the whole
  // object, which is how late answers recognise themselves as stale.
  const runtime = new Map()
  const budgets = new Map()
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
  function request(site, cursor) {
    const rt = runtime.get(site)
    const section = sections[site]
    if (!rt || !section) return
    clearTimers(rt)
    section.loading = true
    const budget = budgetFor(site)
    if (!budget.take()) {
      wait(site, rt, Math.max(1, budget.retryInMs()), () => request(site, cursor))
      return
    }
    section.waitingMs = 0
    run(site, rt, cursor)
  }

  async function run(site, rt, cursor) {
    const section = sections[site]
    const context = current
    rt.lastCursor = cursor
    rt.inFlight = true
    section.loading = true
    section.error = null
    let result
    try {
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
      fail(site, rt, cursor, error)
      return
    }
    if (isStale(site, rt)) return
    rt.inFlight = false
    rt.throttleRetries = 0
    section.loading = false
    apply(site, rt, result || {})
    if (cursor === null) startCount(site, rt, context)
  }

  function fail(site, rt, cursor, error) {
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
    wait(site, rt, Math.max(1, budget.retryInMs()), () => request(site, cursor))
  }

  function apply(site, rt, result) {
    const section = sections[site]
    const safety = current.options.safety
    const fresh = []
    for (const post of Array.isArray(result.posts) ? result.posts : []) {
      if (!post?.key || rt.seen.has(post.key)) continue
      rt.seen.add(post.key)
      section.fetched += 1
      if (safety[post.safety] === false) {
        section.ratingFiltered += 1
        continue
      }
      const kept = markRaw(post)
      postIndex.set(post.key, kept)
      fresh.push(kept)
    }
    section.posts.push(...fresh)
    section.page += 1
    section.cursor = result.nextCursor || null
    section.exhausted = !section.cursor
    if (Array.isArray(result.ignoredTerms)) section.ignoredTerms = result.ignoredTerms
    if (result.note !== undefined) section.note = result.note ?? null
    const total = countOrNull(result.total)
    if (total !== null && (section.total === null || section.totalIsEstimate || !result.totalIsEstimate)) {
      section.total = total
      section.totalIsEstimate = Boolean(result.totalIsEstimate)
    }
    updatePages(section)
    if (fresh.length) Promise.resolve(lookup.lookup(fresh.map((post) => post.key))).catch(() => {})
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
          updatePages(section)
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
    }
    for (const post of sections[site]?.posts || []) postIndex.delete(post.key)
    delete sections[site]
  }

  function resetSection(site) {
    removeSection(site)
    runtime.set(site, {
      controller: new AbortController(),
      timers: new Set(),
      seen: new Set(),
      lastCursor: null,
      inFlight: false,
      throttleRetries: 0,
      countTimer: null,
    })
    const section = newSection(site, effectiveLimit(site, current.limit))
    // Show what the booru will not understand before its results arrive.
    try {
      const translation = adapters[site].translate?.(current.query, current.options)
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
   * search({ query, options, sites, hiddenKeys, limit })
   * Runs at once; scheduleSearch() is the debounced form for a watch.
   * `sites` are ticked SOURCE_IDS (NekoBooru included or not); `limit` is the
   * per-page choice: null/'default' = each booru's own page size, a number =
   * that many everywhere, capped per booru. Re-running the same query only
   * starts newly ticked sites; unticked ones are aborted and removed.
   */
  function search({ query = '', options = {}, sites = [], hiddenKeys: hidden = null, limit = null } = {}) {
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
      if (sameQuery && sections[site]) continue
      resetSection(site)
      request(site, null)
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

  // Next page for one section (grouped mode). False when there is none to load.
  function loadMore(site) {
    const section = sections[site]
    if (!section || !runtime.has(site) || section.loading || !section.cursor) return false
    request(site, section.cursor)
    return true
  }

  // Next page for every ticked section (interleaved mode).
  function loadMoreAll() {
    return order.value.map((site) => loadMore(site)).some(Boolean)
  }

  // Re-run the last request of a failed section, skipping any cooldown wait
  // for the budget (which still defers it while the site cools down).
  function retry(site) {
    const section = sections[site]
    const rt = runtime.get(site)
    if (!section || !rt || !section.error || rt.inFlight) return false
    rt.throttleRetries = 0
    request(site, rt.lastCursor)
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
    loadMore,
    loadMoreAll,
    postByKey,
    markImported,
    retry,
    dispose,
  }
}
