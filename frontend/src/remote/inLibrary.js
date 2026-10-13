import { reactive } from 'vue'
import { isRemoteKey } from './types.js'

// "Already in NekoBooru" lookup for remote posts (section 3.6.1 of
// docs/booru-search-plan.md). Keys from every page that arrives within a short
// window go out as one POST /api/booru-search/in-library request, so a search
// across five boorus costs one round trip instead of five. The badges it
// feeds are a courtesy: a failed request is retried once and then dropped.

export const COALESCE_MS = 150
export const CHUNK_SIZE = 200
export const RETRY_DELAY_MS = 2000

function chunked(list, size) {
  const chunks = []
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size))
  return chunks
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * createInLibraryLookup(api)
 *   -> { found, lookup(keys): Promise<void>, lookupNow(key): Promise<{postId}|null>, mark(key, postId), dispose() }
 *
 * `found` is a reactive Map<key, { postId }> holding only keys that are in
 * the library. `lookup` skips keys already asked (or known), waits
 * COALESCE_MS for more, then posts chunks of CHUNK_SIZE; its promise settles
 * when that batch is done and never rejects. `lookupNow` is for the import
 * queue: one key, no coalescing, no cache of a negative answer, errors thrown.
 */
export function createInLibraryLookup(api, { delayMs = COALESCE_MS, chunkSize = CHUNK_SIZE, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const found = reactive(new Map())
  const asked = new Set()
  let pending = new Set()
  let waiters = []
  let timer = null
  let disposed = false

  function record(answer) {
    for (const [key, value] of Object.entries(answer || {})) {
      const postId = Number(value?.postId)
      if (isRemoteKey(key) && Number.isSafeInteger(postId) && postId > 0) found.set(key, { postId })
    }
  }

  async function send(chunk) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) await sleep(retryDelayMs)
      if (disposed) return
      try {
        const data = await api.lookupInLibrary(chunk)
        if (!disposed) record(data?.found)
        return
      } catch {
        // Retried once below; after that the keys may be asked again later.
      }
    }
    for (const key of chunk) asked.delete(key)
  }

  async function flush() {
    timer = null
    const keys = [...pending]
    const settle = waiters
    pending = new Set()
    waiters = []
    await Promise.all(chunked(keys, chunkSize).map(send))
    for (const resolve of settle) resolve()
  }

  function lookup(keys) {
    for (const key of keys || []) {
      if (!isRemoteKey(key) || asked.has(key) || found.has(key)) continue
      asked.add(key)
      pending.add(key)
    }
    if (disposed || (!pending.size && !timer)) return Promise.resolve()
    return new Promise((resolve) => {
      waiters.push(resolve)
      if (!timer) timer = setTimeout(flush, delayMs)
    })
  }

  async function lookupNow(key) {
    if (!isRemoteKey(key)) return null
    const data = await api.lookupInLibrary([key])
    asked.add(key)
    const value = data?.found?.[key]
    if (value) record({ [key]: value })
    else found.delete(key)
    return found.get(key) || null
  }

  function mark(key, postId) {
    const id = Number(postId)
    if (!isRemoteKey(key) || !Number.isSafeInteger(id) || id <= 0) return
    asked.add(key)
    found.set(key, { postId: id })
  }

  function dispose() {
    disposed = true
    if (timer) clearTimeout(timer)
    timer = null
    pending = new Set()
    for (const resolve of waiters) resolve()
    waiters = []
  }

  return { found, lookup, lookupNow, mark, dispose }
}
