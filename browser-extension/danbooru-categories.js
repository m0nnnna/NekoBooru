;(function installDanbooruCategories(root) {
  // Safebooru's API has no tag categories, but Safebooru mirrors Danbooru's
  // tag vocabulary, so a Safebooru import asks Danbooru for the tags the page
  // left general (P7 in docs/booru-search-plan.md; the web app's copy is
  // frontend/src/remote/danbooruCategories.js):
  //   GET /tags.json?search[name_comma]=a,b,c&only=name,category&limit=N
  // 80 names per request, answers cached a day in chrome.storage.local.
  // Called straight from the import page with credentials omitted, like the
  // background's trace.moe lookup (fetchBooruJson); the extension's host
  // permissions cover it and Danbooru sends CORS headers anyway.
  //
  // Never throws: unknown tags come back general, failed ones stay as they were.

  const ORIGIN = 'https://danbooru.donmai.us'
  const BATCH = 80
  const TTL_MS = 24 * 3600 * 1000
  const TIMEOUT_MS = 15000
  const STORAGE_KEY = 'nekobooruDanbooruTagCategories'
  const MAX_STORED = 5000
  const CATEGORY_NAMES = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' }
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

  function categoryName(value) {
    return CATEGORY_NAMES[Number(value)] || 'general'
  }

  // The form Danbooru stores a name in, or '' for one name_comma cannot carry.
  function lookupName(raw) {
    const name = String(raw ?? '').trim().toLowerCase()
    if (!name || name.length > 170 || /[,\s]/.test(name) || UNSAFE_KEYS.has(name)) return ''
    return name
  }

  function categoriesUrl(names) {
    const params = new URLSearchParams({
      'search[name_comma]': names.join(','),
      only: 'name,category',
      limit: String(names.length),
    })
    return `${ORIGIN}/tags.json?${params}`
  }

  function defaultStorage() {
    try {
      return root.chrome?.storage?.local || null
    } catch {
      return null
    }
  }

  async function readCache(storage, now) {
    const cache = new Map()
    try {
      const saved = (await storage?.get(STORAGE_KEY))?.[STORAGE_KEY]
      for (const [name, value] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
        const [category, at] = Array.isArray(value) ? value : []
        if (Object.values(CATEGORY_NAMES).includes(category) && now - Number(at) < TTL_MS) {
          cache.set(name, { category, at: Number(at) })
        }
      }
    } catch {
      // Unreadable storage: every tag is simply asked again.
    }
    return cache
  }

  async function writeCache(storage, cache, now) {
    if (!storage) return
    const rows = [...cache.entries()]
      .filter(([, entry]) => now - entry.at < TTL_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_STORED)
    try {
      await storage.set({ [STORAGE_KEY]: Object.fromEntries(rows.map(([name, entry]) => [name, [entry.category, entry.at]])) })
    } catch {
      // Quota or storage gone; the import goes on without the cache.
    }
  }

  async function fetchBatch(fetchImpl, batch, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(categoriesUrl(batch), { credentials: 'omit', signal: controller.signal })
      if (!response?.ok) {
        const error = new Error(`Danbooru answered HTTP ${response?.status}`)
        error.status = response?.status
        throw error
      }
      const rows = await response.json()
      if (!Array.isArray(rows)) throw new Error('Danbooru sent an unexpected tag response')
      const found = new Map()
      for (const row of rows) {
        const name = lookupName(row?.name)
        if (name) found.set(name, categoryName(row?.category))
      }
      return found
    } finally {
      clearTimeout(timer)
    }
  }

  // names -> { name: category } for every name answered (cache or Danbooru).
  async function resolveDanbooruCategories(names, options = {}) {
    const fetchImpl = options.fetch || root.fetch
    const storage = options.storage === undefined ? defaultStorage() : options.storage
    const now = typeof options.now === 'function' ? options.now() : Date.now()
    const timeoutMs = options.timeoutMs || TIMEOUT_MS
    const cache = await readCache(storage, now)
    const answer = {}
    const pending = []
    for (const raw of Array.isArray(names) ? names : []) {
      const name = lookupName(raw)
      if (!name || name in answer || pending.includes(name)) continue
      if (cache.has(name)) answer[name] = cache.get(name).category
      else pending.push(name)
    }
    let learned = false
    for (let offset = 0; offset < pending.length && typeof fetchImpl === 'function'; offset += BATCH) {
      const batch = pending.slice(offset, offset + BATCH)
      let found
      try {
        found = await fetchBatch(fetchImpl, batch, timeoutMs)
      } catch (error) {
        // Throttled: the remaining batches would be refused too.
        if (error?.status === 429 || error?.status === 503) break
        continue
      }
      for (const name of batch) {
        const category = found.get(name) || 'general'
        answer[name] = category
        cache.set(name, { category, at: now })
      }
      learned = true
    }
    if (learned) await writeCache(storage, cache, now)
    return answer
  }

  // A Safebooru job's general tags get Danbooru's categories, in place. Other
  // kinds, the id tag, and tags the page already categorised are untouched.
  async function applyDanbooruCategories(job, options = {}) {
    if (job?.kind !== 'safebooru') return job
    const media = Array.isArray(job.media) ? job.media : []
    const general = (item, tag) => (item.tagCategories?.[tag] || 'general') === 'general' && tag !== job.groupTag
    const names = [...new Set(media.flatMap((item) => (item.tags || []).filter((tag) => general(item, tag))))]
    if (!names.length) return job
    let answer = {}
    try {
      answer = await resolveDanbooruCategories(names, options)
    } catch {
      return job
    }
    for (const item of media) {
      item.tagCategories = item.tagCategories || {}
      for (const tag of item.tags || []) {
        const category = answer[lookupName(tag)]
        if (category && general(item, tag) && !UNSAFE_KEYS.has(tag)) item.tagCategories[tag] = category
      }
    }
    return job
  }

  const api = {
    DANBOORU_CATEGORY_BATCH: BATCH,
    DANBOORU_CATEGORY_TTL_MS: TTL_MS,
    DANBOORU_CATEGORY_STORAGE_KEY: STORAGE_KEY,
    danbooruCategoryName: categoryName,
    danbooruCategoriesUrl: categoriesUrl,
    resolveDanbooruCategories,
    applyDanbooruCategories,
  }
  root.NekoBooruDanbooruCategories = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
