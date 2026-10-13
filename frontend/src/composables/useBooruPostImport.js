import { computed, onUnmounted, ref, watch } from 'vue'
import { api as defaultApi } from '../api/client'
import { ADAPTERS } from '../remote/adapters/index.js'
import { createInLibraryLookup } from '../remote/inLibrary.js'
import { useImportQueue } from '../remote/useImportQueue.js'

// The booru post page's "Import to NekoBooru" (section 4.4 of
// docs/booru-search-plan.md). Opened from home, it imports through the home
// view's own queue (kept alive behind this page), so the import shows on the
// Import card and swaps the post in the home selection; opened from its URL
// alone, it runs a queue of its own. Knows whether the shown post is in the
// library (the context's answer first, then the backend's), and turns into
// the library post's id once an import or merge lands.
const FINISHED = new Set(['done', 'skipped', 'failed', 'cancelled'])

/**
 * useBooruPostImport({ post, context })
 * `post` is a ref to the shown RemotePost, `context` the booruPostContext
 * store (optional). Returns { libraryPostId, importing, status, importPost }.
 */
export function useBooruPostImport({ post, context = null, api = defaultApi, adapters = ADAPTERS }) {
  const lookup = createInLibraryLookup(api)
  const libraryPostId = ref(null)
  const result = ref(null)

  const shared = context?.importer || null
  const ownQueue = shared ? null : useImportQueue({ api, adapters, inLibrary: lookup })
  const queue = shared?.queue || ownQueue
  const enqueue = shared ? shared.enqueue : (posts) => ownQueue.enqueue(posts)

  const item = computed(() => queue.items.find((entry) => entry.key === post.value?.key) || null)
  const importing = computed(() => Boolean(item.value && !FINISHED.has(item.value.status)))
  // The running item's progress, else how the last import of this post ended.
  const status = computed(() => {
    if (importing.value) return { text: item.value.message, kind: 'progress' }
    if (result.value?.key === post.value?.key) return result.value
    return null
  })

  // An import or merge of the shown post landed (from here or the Import card).
  watch(
    () => [item.value?.key, item.value?.postId],
    ([key, postId]) => {
      const id = Number(postId)
      if (!key || !(id > 0)) return
      context?.markImported(key, id)
      if (key === post.value?.key) libraryPostId.value = id
    },
  )

  watch(
    () => post.value?.key,
    async (key) => {
      libraryPostId.value = key ? context?.libraryIdFor(key) ?? null : null
      if (!key) return
      try {
        const found = await lookup.lookupNow(key)
        if (found?.postId && post.value?.key === key) libraryPostId.value = found.postId
      } catch {
        // The badge is a courtesy; an import still checks the library first.
      }
    },
    { immediate: true },
  )

  async function importPost() {
    const target = post.value
    if (!target?.key || importing.value) return
    result.value = null
    const [added] = enqueue([target])
    if (!added) return
    if (added.status === 'failed') {
      result.value = { key: target.key, text: added.message, kind: 'error' }
      return
    }
    await queue.start()
    const settled = queue.items.find((entry) => entry.key === target.key)
    if (!settled || settled.status === 'cancelled') return
    result.value = { key: target.key, text: settled.message, kind: settled.status === 'failed' ? 'error' : 'success' }
  }

  onUnmounted(() => {
    ownQueue?.cancel()
    lookup.dispose()
  })

  return { libraryPostId, importing, status, importPost }
}
