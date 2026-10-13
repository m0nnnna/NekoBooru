import { DANBOORU_FETCH_OPTIONS, DANBOORU_ORIGIN, readJson } from './adapters/danbooru.js'
import { timeoutSignal } from './timeoutSignal.js'
import { CATEGORIES } from './types.js'

// Safebooru's API has no tag categories, but Safebooru mirrors Danbooru's tag
// vocabulary, so imports ask Danbooru (section 7 item 1 / P7 of
// docs/booru-search-plan.md). Only at import time, never per search page:
//   GET /tags.json?search[name_comma]=a,b,c&only=name,category&limit=N
// 80 names per request (the backend's site_imports.NAME_BATCH), answers kept a
// day in memory and in localStorage. Danbooru sends CORS headers, so this is
// a browser-direct request like the Danbooru search adapter's.
//
// Never throws: a tag Danbooru does not know comes back 'general', and a tag
// whose request failed (network, HTTP error, timeout, abort) is left out of
// the answer so the caller keeps its own category - general for Safebooru.

export const DANBOORU_CATEGORY_BATCH = 80
export const DANBOORU_CATEGORY_TTL_MS = 24 * 3600 * 1000
export const DANBOORU_CATEGORY_TIMEOUT_MS = 15000
export const DANBOORU_CATEGORY_STORAGE_KEY = 'nekobooru.danbooruTagCategories.v1'
// Enough for a long import session; the oldest answers are dropped beyond it.
const MAX_STORED = 5000
// Danbooru's own tag names stay well under this; longer is not a tag.
const MAX_NAME_LENGTH = 170

// Danbooru's category numbers. 2 is unused; anything else counts as general.
export const DANBOORU_CATEGORY_NAMES = Object.freeze({ 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' })

export function danbooruCategoryName(value) {
  const name = DANBOORU_CATEGORY_NAMES[Number(value)]
  return name && CATEGORIES.has(name) ? name : 'general'
}

// The form Danbooru stores a name in, or '' for one name_comma cannot carry
// (a comma would split it; whitespace is not part of any tag).
export function danbooruLookupName(raw) {
  const name = String(raw ?? '').trim().toLowerCase()
  if (!name || name.length > MAX_NAME_LENGTH || /[,\s]/.test(name)) return ''
  return name
}

export function danbooruCategoriesUrl(names) {
  const params = new URLSearchParams({
    'search[name_comma]': names.join(','),
    only: 'name,category',
    limit: String(names.length),
  })
  return `${DANBOORU_ORIGIN}/tags.json?${params}`
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

/**
 * createDanbooruCategoryResolver({ fetch, storage, now, timeoutMs, batchSize })
 *   -> resolve(names, { signal }) -> Promise<Object<name, category>>
 * `fetch` defaults to the global one at call time; `storage` to localStorage
 * (null turns persistence off). Every option exists for tests.
 */
export function createDanbooruCategoryResolver({
  fetch: fetchImpl = null,
  storage,
  now = () => Date.now(),
  timeoutMs = DANBOORU_CATEGORY_TIMEOUT_MS,
  batchSize = DANBOORU_CATEGORY_BATCH,
} = {}) {
  const memory = new Map() // name -> { category, at }
  let loaded = false
  const store = () => (storage === undefined ? defaultStorage() : storage)

  function fresh(entry) {
    return entry && now() - entry.at < DANBOORU_CATEGORY_TTL_MS
  }

  function loadStored() {
    if (loaded) return
    loaded = true
    try {
      const saved = JSON.parse(store()?.getItem(DANBOORU_CATEGORY_STORAGE_KEY) || '{}')
      for (const [name, value] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
        const [category, at] = Array.isArray(value) ? value : []
        const entry = { category, at: Number(at) }
        if (CATEGORIES.has(category) && fresh(entry) && !memory.has(name)) memory.set(name, entry)
      }
    } catch {
      // Unreadable or blocked storage: the memory cache still works.
    }
  }

  function persist() {
    const target = store()
    if (!target) return
    const entries = [...memory.entries()]
      .filter(([, entry]) => fresh(entry))
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_STORED)
    try {
      target.setItem(DANBOORU_CATEGORY_STORAGE_KEY, JSON.stringify(
        Object.fromEntries(entries.map(([name, entry]) => [name, [entry.category, entry.at]])),
      ))
    } catch {
      // Quota or blocked storage; answers stay cached for this page.
    }
  }

  function cached(name) {
    const entry = memory.get(name)
    if (fresh(entry)) return entry.category
    if (entry) memory.delete(name)
    return null
  }

  // One request; throws on any failure so the batch stays unanswered.
  async function fetchBatch(batch, signal) {
    const doFetch = fetchImpl || globalThis.fetch
    const linked = timeoutSignal(signal, timeoutMs)
    try {
      const response = await doFetch(danbooruCategoriesUrl(batch), { ...DANBOORU_FETCH_OPTIONS, signal: linked.signal })
      if (!response?.ok) {
        const error = new Error(`Danbooru answered HTTP ${response?.status}`)
        error.status = response?.status
        throw error
      }
      const rows = await readJson(response)
      if (!Array.isArray(rows)) throw new Error('Danbooru sent an unexpected tag response')
      const found = new Map()
      for (const row of rows) {
        const name = danbooruLookupName(row?.name)
        if (name) found.set(name, danbooruCategoryName(row?.category))
      }
      return found
    } finally {
      linked.done()
    }
  }

  async function resolve(names, { signal } = {}) {
    loadStored()
    const answer = {}
    const wanted = new Set()
    const rawByName = new Map()
    for (const raw of Array.isArray(names) ? names : []) {
      const name = danbooruLookupName(raw)
      if (!name) continue
      if (!rawByName.has(name)) rawByName.set(name, [])
      rawByName.get(name).push(raw)
      const category = cached(name)
      if (category) answer[raw] = category
      else wanted.add(name)
    }

    const pending = [...wanted]
    let learned = false
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (signal?.aborted) break
      const batch = pending.slice(offset, offset + batchSize)
      let found
      try {
        found = await fetchBatch(batch, signal)
      } catch (error) {
        // Throttled: the remaining batches would be refused too.
        if (error?.status === 429 || error?.status === 503) break
        continue
      }
      const at = now()
      for (const name of batch) {
        const category = found.get(name) || 'general'
        memory.set(name, { category, at })
        for (const raw of rawByName.get(name)) answer[raw] = category
      }
      learned = true
    }
    if (learned) persist()
    return answer
  }

  return { resolve, clear: () => memory.clear() }
}

// The app-wide resolver, shared so the day-long cache spans import runs.
const shared = createDanbooruCategoryResolver()
export function resolveDanbooruCategories(names, options) {
  return shared.resolve(names, options)
}
