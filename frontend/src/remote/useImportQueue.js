import { computed, reactive, ref } from 'vue'
import { booruSearchTag, normalizeTagName } from '../utils/booruSearchTag'
import { resolveDanbooruCategories } from './danbooruCategories.js'
import { CATEGORIES, SAFETY_ORDER, booruDisplayNames, idTagFor, stricterSafety } from './types.js'

// Imports selected remote posts into the library one at a time, the way the
// browser extension's search-page import does (browser-extension/site-import.js
// importAll): a pause between downloads, a growing back-off when a site says
// "slow down", and posts already in the library merged instead of downloaded.
// `api` and `adapters` are injected so the queue can be tested with fakes.

export const NEW_POOL = '__new__'
export const IMPORT_PROFILE = 'booru_search'
export const DOWNLOAD_GAP_MS = 1500
export const RETRY_DELAYS_MS = [10000, 30000, 60000]
export const BUSY_RETRY_MS = 5000
export const PROGRESS_POLL_MS = 1000
const LOOKUP_CHUNK = 500
const FINISHED = new Set(['done', 'skipped', 'failed', 'cancelled'])
// A server-suggested wait (Retry-After) is honoured up to this long, the
// same cap as the search budget's cooldown (remote/budget.js).
const MAX_THROTTLE_WAIT_MS = 900000
// Sites whose character/copyright spellings are converted to Danbooru's.
const RENAMED_SITES = new Set(['sankaku', 'e621'])
// Sites whose search results carry no tag categories, so imports look them
// up once per run: Gelbooru through the backend, Safebooru through Danbooru.
const CATEGORY_SITES = new Set(['gelbooru', 'safebooru'])
const categoryKey = (site, tag) => `${site}:${tag}`
const SITE_LABELS = {
  danbooru: 'Danbooru',
  e621: 'e621',
  sankaku: 'Sankaku',
  gelbooru: 'Gelbooru',
  safebooru: 'Safebooru',
}
const UNAVAILABLE_REASONS = {
  hidden: 'hidden from logged-out visitors',
  deleted: 'deleted on the site',
  banned: 'banned on the site',
}

class ImportCancelled extends Error {}

// "Downloading original… 12.3 / 36.0 MB (34%) · 180 KB/s · 70s", the
// extension's downloadProgressText (browser-extension/site-import-core.js).
export function downloadProgressText(progress, elapsedMs) {
  const received = Math.max(0, Number(progress?.received) || 0)
  const total = Math.max(0, Number(progress?.total) || 0)
  const seconds = Math.max(0, Math.round((Number(elapsedMs) || 0) / 1000))
  const megabytes = (bytes) => (bytes / 1048576).toFixed(1)
  const parts = [total
    ? `${megabytes(received)} / ${megabytes(total)} MB (${Math.min(100, Math.floor((received * 100) / total))}%)`
    : `${megabytes(received)} MB`]
  if (seconds > 0 && received > 0) parts.push(`${Math.round(received / 1024 / seconds)} KB/s`)
  parts.push(`${seconds}s`)
  return `Downloading original… ${parts.join(' · ')}`
}

// The booru's own spelling of a flattened tag (miyu_blue_archive ->
// miyu_(blue_archive)), recovered from its display name. Lookups that talk to
// a booru need this form; the flattened one would not be found.
function rawSpelling(post, tag) {
  return booruSearchTag(tag, post.tagDisplayNames?.[tag] || '')
}

const unique = (values) => [...new Set(values)]
const chunked = (values, size) => Array.from({ length: Math.ceil(values.length / size) },
  (_, index) => values.slice(index * size, (index + 1) * size))

function errorMessage(error) {
  return error?.message || String(error || 'Unknown error')
}

// A site (or its CDN, via the backend) asking to slow down. The backend's
// from-url error carries the upstream status in its text, which is what the
// extension matches; a relay answers 429 itself (client.js puts it in
// `status`); adapters' RemoteSearchError says so in `kind`.
function isThrottled(error) {
  return /HTTP (429|503)\b/.test(errorMessage(error)) || error?.kind === 'throttled'
    || error?.status === 429 || error?.status === 503
}

// The scheduled back-off, or longer when the error says how long to wait:
// the relays' detail.retryAfter (seconds) or RemoteSearchError.retryAfterMs.
function throttleWaitMs(error, scheduledMs) {
  const hints = [Number(error?.detail?.retryAfter) * 1000, Number(error?.retryAfterMs)]
  const hinted = Math.max(0, ...hints.filter((value) => Number.isFinite(value)))
  return Math.max(scheduledMs, Math.min(hinted, MAX_THROTTLE_WAIT_MS))
}

function isDuplicatePost(error) {
  return error?.status === 409 && error?.detail?.code === 'duplicate_post'
}

function unavailableMessage(post) {
  const reason = UNAVAILABLE_REASONS[post?.unavailable]
  return reason ? `No original file · ${reason}` : 'No original file'
}

function newProgressId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * The tags, categories and display names one post is imported with, after the
 * run's looked-up categories and Danbooru spellings are applied.
 * `run.categories`: Map<categoryKey(site, flatTag), category>;
 * `run.renames`: Map<flatTag, {from, to, flatTo}>.
 */
export function prepareImport(post, run, options) {
  const tagCategories = { ...(post.tagCategories || {}) }
  const tagDisplayNames = { ...(post.tagDisplayNames || {}) }
  const aliases = []
  let tags = Array.isArray(post.tags) ? [...post.tags] : []

  if (CATEGORY_SITES.has(post.site)) {
    for (const tag of tags) {
      const category = run.categories.get(categoryKey(post.site, tag))
      if (category) tagCategories[tag] = category
    }
  }

  // Applied like useDanbooruNames in browser-extension/site-import.js:
  // replace in tags, move the category, remember the alias for afterwards.
  if (RENAMED_SITES.has(post.site)) {
    for (const tag of tags) {
      const rename = run.renames.get(tag)
      if (!rename) continue
      if (tagCategories[tag]) {
        tagCategories[rename.flatTo] = tagCategories[tag]
        delete tagCategories[tag]
      }
      delete tagDisplayNames[tag]
      Object.assign(tagDisplayNames, booruDisplayNames([rename.to]))
      aliases.push({ alias: rename.from, target: rename.to })
    }
    tags = unique(tags.map((tag) => run.renames.get(tag)?.flatTo || tag))
  }

  const extraTags = (Array.isArray(options?.extraTags) ? options.extraTags : [])
    .map((tag) => normalizeTagName(tag))
    .filter(Boolean)
  tags = unique([...tags, ...extraTags])
  const idTag = idTagFor(post)
  if (!tags.includes(idTag)) tags.push(idTag)
  tagCategories[idTag] = 'meta'

  const override = SAFETY_ORDER.includes(options?.safetyOverride) ? options.safetyOverride : ''
  return {
    tags,
    tagCategories,
    tagDisplayNames,
    idTag,
    aliases,
    safety: override || post.safety || 'safe',
  }
}

// siteImportPostBody(job, item, token) from site-import-core.js, with autoTag
// driven by the Import card's switch.
export function importPostBody(post, prepared, options, contentToken) {
  return {
    contentToken,
    safety: prepared.safety,
    tags: prepared.tags,
    tagCategories: prepared.tagCategories,
    tagDisplayNames: prepared.tagDisplayNames,
    source: post.postUrl,
    autoTag: options?.autoTag === true,
    autoTagProfile: IMPORT_PROFILE,
  }
}

// The PUT body of the extension's mergeDuplicate: the library's tags first,
// then the import's, and the stricter of the two ratings.
export function mergePostBody(existing, prepared, post) {
  return {
    tags: unique([...(existing?.tags || []), ...prepared.tags]),
    safety: stricterSafety(existing?.safety, prepared.safety),
    source: existing?.source || post.postUrl || null,
    tagCategories: prepared.tagCategories,
    tagDisplayNames: prepared.tagDisplayNames,
  }
}

function newRun() {
  return {
    categories: new Map(),
    askedCategories: new Set(),
    renames: new Map(),
    askedNames: new Set(),
    importedIds: [],
    aliased: new Set(),
  }
}

// `danbooruCategories(rawNames, { signal })` -> { raw: category } resolves
// Safebooru's categories; injectable so tests never reach Danbooru.
export function useImportQueue({
  api,
  adapters = {},
  inLibrary = null,
  onImported = null,
  danbooruCategories = resolveDanbooruCategories,
} = {}) {
  const items = reactive([])
  const running = ref(false)
  const poolResult = ref(null)
  const options = reactive({
    autoTag: false,
    extraTags: [],
    safetyOverride: '',
    poolId: null,
    newPoolName: '',
  })
  const progress = computed(() => ({
    done: items.filter((item) => item.status === 'done').length,
    total: items.length,
    failed: items.filter((item) => item.status === 'failed').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
  }))

  // Bumped by cancel(); an item waiting (gap, back-off) under an older value
  // stops waiting and is cancelled.
  let cancelGeneration = 0
  const wakers = new Set()
  let runPromise = null
  // Aborted by cancel() so a slow category lookup does not hold the queue.
  let lookupAbort = null

  const setStatus = (item, status, message) => Object.assign(item, {
    status,
    message,
    ...(status === 'retrying' ? {} : { retryAt: null }),
  })

  function pause(ms, generation) {
    if (generation !== cancelGeneration) return Promise.reject(new ImportCancelled())
    return new Promise((resolve, reject) => {
      let timer = null
      const done = () => {
        clearTimeout(timer)
        wakers.delete(done)
        if (generation === cancelGeneration) resolve()
        else reject(new ImportCancelled())
      }
      timer = setTimeout(done, ms)
      wakers.add(done)
    })
  }

  function enqueue(posts) {
    const added = []
    for (const post of Array.isArray(posts) ? posts : [posts]) {
      if (!post?.key) continue
      const index = items.findIndex((item) => item.key === post.key)
      if (index >= 0) {
        if (!FINISHED.has(items[index].status)) continue
        items.splice(index, 1)
      }
      const available = Boolean(post.fileUrl)
      items.push({
        key: post.key,
        post,
        status: available ? 'queued' : 'failed',
        message: available ? 'Waiting' : unavailableMessage(post),
        postId: null,
        duplicate: false,
        attempt: 0,
        // When a 'retrying' item tries again (ms epoch), for a live countdown.
        retryAt: null,
      })
      added.push(items[items.length - 1])
    }
    return added
  }

  // The batched lookups, done before the first item for everything queued
  // and again only for posts queued later in the same run.
  async function prepareLookups(run) {
    const queued = items.filter((item) => item.status === 'queued').map((item) => item.post)
    lookupAbort = new AbortController()
    const { signal } = lookupAbort
    try {
      await lookupCategories(run, 'gelbooru', queued, async (chunk) => (await api.gelbooruTagCategories(chunk))?.categories)
      await lookupCategories(run, 'safebooru', queued, (chunk) => danbooruCategories(chunk, { signal }))
      await lookupDanbooruNames(run, queued.filter((post) => RENAMED_SITES.has(post.site)))
    } finally {
      lookupAbort = null
    }
  }

  // `fetchChunk(rawNames)` -> { raw: category }. Only tags the site left
  // general are asked about, each once per run.
  async function lookupCategories(run, site, posts, fetchChunk) {
    const flatByRaw = new Map()
    for (const post of posts) {
      if (post.site !== site) continue
      for (const tag of post.tags || []) {
        const key = categoryKey(site, tag)
        const current = post.tagCategories?.[tag]
        if (run.askedCategories.has(key) || (current && current !== 'general')) continue
        run.askedCategories.add(key)
        flatByRaw.set(rawSpelling(post, tag), tag)
      }
    }
    for (const chunk of chunked([...flatByRaw.keys()], LOOKUP_CHUNK)) {
      try {
        const categories = await fetchChunk(chunk)
        for (const [raw, category] of Object.entries(categories || {})) {
          const flat = flatByRaw.get(raw)
          if (flat && CATEGORIES.has(category)) run.categories.set(categoryKey(site, flat), category)
        }
      } catch {
        // Categories are a courtesy: the tags import as general.
      }
    }
  }

  async function lookupDanbooruNames(run, posts) {
    const flatByRaw = new Map()
    const tagCategories = {}
    for (const post of posts) {
      for (const tag of post.tags || []) {
        const category = post.tagCategories?.[tag]
        if (run.askedNames.has(tag) || (category !== 'character' && category !== 'copyright')) continue
        run.askedNames.add(tag)
        const raw = rawSpelling(post, tag)
        flatByRaw.set(raw, tag)
        tagCategories[raw] = category
      }
    }
    for (const chunk of chunked([...flatByRaw.keys()], LOOKUP_CHUNK)) {
      const chunkCategories = Object.fromEntries(chunk.map((raw) => [raw, tagCategories[raw]]))
      try {
        const data = await api.danbooruNames(chunk, chunkCategories)
        for (const [from, to] of Object.entries(data?.renames || {})) {
          const flat = flatByRaw.get(from)
          const flatTo = normalizeTagName(to)
          if (flat && flatTo && flatTo !== flat) run.renames.set(flat, { from, to, flatTo })
        }
      } catch {
        // Best effort, as in the extension: the source spelling is kept.
      }
    }
  }

  async function lookupExisting(key) {
    try {
      const found = await inLibrary?.lookupNow?.(key)
      const postId = Number(found?.postId)
      return postId > 0 ? postId : null
    } catch {
      return null
    }
  }

  async function refreshPost(post) {
    const adapter = adapters?.[post.site]
    if (typeof adapter?.refresh !== 'function') return post
    return adapter.refresh(post, { signal: new AbortController().signal, api })
  }

  // Polls the backend's byte count once a second, like the extension's
  // followDownload. Returns the function that stops polling.
  function followDownload(item, progressId) {
    const started = Date.now()
    let stopped = false
    let timer = null
    const tick = async () => {
      try {
        const data = await api.getFromUrlProgress(progressId)
        if (!stopped && item.status === 'downloading') {
          item.message = downloadProgressText(data, Date.now() - started)
        }
      } catch {
        // Progress is a courtesy; the download carries on regardless.
      }
      if (!stopped) timer = setTimeout(tick, PROGRESS_POLL_MS)
    }
    timer = setTimeout(tick, PROGRESS_POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }

  // resolving -> downloading, retried after 10/30/60 s when the site
  // throttles, and once after 5 s when the same file is already downloading.
  async function fetchOriginal(item, generation) {
    const label = SITE_LABELS[item.post.site] || 'The site'
    let busyRetried = false
    for (let attempt = 0; ;) {
      let phase = 'resolving'
      try {
        setStatus(item, 'resolving', 'Getting the original file link…')
        const fresh = await refreshPost(item.post)
        if (!fresh?.fileUrl) throw new Error(unavailableMessage(fresh || item.post))
        phase = 'downloading'
        setStatus(item, 'downloading', 'Downloading original…')
        const progressId = newProgressId()
        const stop = followDownload(item, progressId)
        try {
          const upload = await api.fetchFromUrl({ url: fresh.fileUrl, referer: fresh.referer, progressId })
          return { fresh, upload }
        } finally {
          stop()
        }
      } catch (error) {
        const scheduled = RETRY_DELAYS_MS[attempt]
        if (isThrottled(error) && scheduled !== undefined) {
          const delay = throttleWaitMs(error, scheduled)
          attempt += 1
          item.attempt = attempt
          item.retryAt = Date.now() + delay
          setStatus(item, 'retrying', `${label} asked to slow down · retrying in ${Math.round(delay / 1000)} s…`)
          await pause(delay, generation)
          continue
        }
        if (phase === 'downloading' && error?.status === 409 && !busyRetried) {
          busyRetried = true
          item.retryAt = Date.now() + BUSY_RETRY_MS
          setStatus(item, 'retrying', 'This file is already downloading · retrying in 5 s…')
          await pause(BUSY_RETRY_MS, generation)
          continue
        }
        throw error
      }
    }
  }

  async function mergeInto(existing, postId, prepared, post) {
    const updated = await api.updatePost(postId, mergePostBody(existing, prepared, post))
    return updated || existing
  }

  // The 409 duplicate_post path of POST /api/posts: restore a soft-deleted
  // copy first, then merge, exactly like the extension's mergeDuplicate.
  async function mergeDuplicate(detail, prepared, post) {
    let existing = detail?.post || {}
    const postId = Number(detail?.postId || existing.id)
    if (!postId) throw new Error('The original already exists, but NekoBooru did not return its post ID.')
    if (detail?.deleted || existing.deletedAt) existing = await api.restorePost(postId)
    return { postId, post: await mergeInto(existing, postId, prepared, post) }
  }

  async function createAliases(run, site, aliases) {
    for (const { alias, target } of aliases) {
      const marker = `${alias}\n${target}`
      if (run.aliased.has(marker)) continue
      run.aliased.add(marker)
      try {
        await api.createAlias(site === 'sankaku' ? { alias, target, sankakuName: alias } : { alias, target })
      } catch {
        // Already an alias (409) or refused (400); the post is imported either way.
      }
    }
  }

  async function finishItem(item, run, { status, message, postId, postDict, prepared }) {
    item.postId = postId
    setStatus(item, status, message)
    if (!run.importedIds.includes(postId)) run.importedIds.push(postId)
    try {
      onImported?.(item.key, postId, postDict)
    } catch (error) {
      console.error('Import queue onImported handler failed', error)
    }
    await createAliases(run, item.post.site, prepared.aliases)
  }

  // One item, start to finish. Returns whether it got as far as the site
  // (refresh or download), which is what the next item's gap depends on.
  async function processItem(item, run, downloadedLast) {
    const generation = cancelGeneration
    const post = item.post
    let reachedSite = false
    item.attempt = 0
    item.duplicate = false
    item.postId = null
    item.retryAt = null
    try {
      setStatus(item, 'checking', 'Checking the library…')
      const existingId = await lookupExisting(item.key)
      if (existingId) {
        setStatus(item, 'merging', 'Already in NekoBooru · merging tags…')
        const prepared = prepareImport(post, run, options)
        const existing = await api.getPost(existingId)
        const updated = await mergeInto(existing, existingId, prepared, post)
        await finishItem(item, run, {
          status: 'skipped',
          message: `Already in NekoBooru · tags merged · #${existingId}`,
          postId: existingId,
          postDict: updated,
          prepared,
        })
        return false
      }

      if (downloadedLast) {
        item.message = 'Waiting between downloads…'
        await pause(DOWNLOAD_GAP_MS, generation)
      }
      reachedSite = true
      const { fresh, upload } = await fetchOriginal(item, generation)
      const prepared = prepareImport(fresh, run, options)

      setStatus(item, 'saving', 'Saving post…')
      let created
      try {
        created = await api.createPost(importPostBody(fresh, prepared, options, upload?.token))
      } catch (error) {
        if (!isDuplicatePost(error)) throw error
        setStatus(item, 'merging', 'Already in NekoBooru · merging tags…')
        const merged = await mergeDuplicate(error.detail, prepared, fresh)
        item.duplicate = true
        await finishItem(item, run, {
          status: 'done',
          message: `Already existed · tags merged · #${merged.postId}`,
          postId: merged.postId,
          postDict: merged.post,
          prepared,
        })
        return true
      }
      const postId = Number(created?.id)
      if (!postId) throw new Error('NekoBooru did not return the new post ID.')
      await finishItem(item, run, {
        status: 'done',
        message: `Imported · #${postId}`,
        postId,
        postDict: created,
        prepared,
      })
      return true
    } catch (error) {
      if (error instanceof ImportCancelled) setStatus(item, 'cancelled', 'Cancelled')
      else setStatus(item, 'failed', errorMessage(error))
      return reachedSite
    }
  }

  // After the queue drains: every post this run imported or merged goes into
  // the chosen pool, creating it first for "Create new pool".
  async function addToPool(run) {
    const ids = run.importedIds
    const chosen = options.poolId
    if (chosen === null || chosen === undefined || chosen === '' || !ids.length) return
    let poolId = chosen
    try {
      if (chosen === NEW_POOL) {
        const pool = await api.createPool({ name: String(options.newPoolName || '').trim() || 'Booru import' })
        poolId = pool?.id
        if (!poolId) throw new Error('NekoBooru did not return the new pool ID.')
      }
      await api.addPostsToPool(poolId, [...ids])
      poolResult.value = { poolId, added: ids.length, error: null }
    } catch (error) {
      poolResult.value = { poolId: chosen === NEW_POOL ? null : poolId, added: 0, error: errorMessage(error) }
    }
  }

  async function drain() {
    const run = newRun()
    let downloadedLast = false
    try {
      for (;;) {
        const item = items.find((entry) => entry.status === 'queued')
        if (!item) break
        await prepareLookups(run)
        // A cancel() during the lookups already marked this item cancelled.
        if (item.status !== 'queued') continue
        downloadedLast = await processItem(item, run, downloadedLast)
      }
      await addToPool(run)
    } finally {
      running.value = false
      runPromise = null
    }
  }

  // Runs until nothing is queued. Calling it while running returns the
  // current run's promise instead of starting a second one.
  function start() {
    if (runPromise) return runPromise
    running.value = true
    poolResult.value = null
    runPromise = drain()
    return runPromise
  }

  // The current item finishes (unless it is only waiting, which stops now);
  // everything still queued is cancelled.
  function cancel() {
    cancelGeneration += 1
    lookupAbort?.abort()
    for (const item of items) {
      if (item.status === 'queued') setStatus(item, 'cancelled', 'Cancelled')
    }
    for (const wake of [...wakers]) wake()
  }

  function clearFinished() {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (FINISHED.has(items[index].status)) items.splice(index, 1)
    }
  }

  return {
    items,
    running,
    progress,
    options,
    poolResult,
    enqueue,
    start,
    cancel,
    clearFinished,
  }
}
