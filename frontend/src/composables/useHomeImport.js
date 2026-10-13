import { onUnmounted } from 'vue'
import { api as defaultApi } from '../api/client'
import { ADAPTERS } from '../remote/adapters/index.js'
import { useImportQueue } from '../remote/useImportQueue.js'
import { libraryKey } from '../remote/types.js'

// The home view's booru import (section 4.4 of docs/booru-search-plan.md):
// one useImportQueue for the Import card and the remote viewer. Each imported
// (or merged) post takes its booru post's place in the selection as a
// library key, gets its "in library" badge, and is handed to the library
// batch tools so "Tags & Rating" and friends apply to it straight away.

/**
 * useHomeImport({ booru, selection, showMessage })
 * `booru` is useHomeBooruSearch()'s return, `selection` useMixedSelection()'s,
 * `showMessage(text, kind)` the batch toast. Returns { queue, importQueue,
 * importFromViewer, onImported, enqueueSelected }; `importQueue` is the queue
 * object for ImportCard, whose enqueue swaps posts already in the library
 * instead of queueing them.
 */
export function useHomeImport({ booru, selection, showMessage = () => {}, api = defaultApi, adapters = ADAPTERS }) {
  let disposed = false

  const queue = useImportQueue({
    api,
    adapters,
    inLibrary: booru.results.lookup,
    onImported,
  })

  // queue -> home view: swap the key in place, badge the booru card, and make
  // the library post reachable for the batch tools.
  function onImported(key, postId, postDict) {
    if (disposed) return
    const id = Number(postId)
    if (!id) return
    selection.replaceKey(key, libraryKey(id))
    booru.markImported(key, id)
    if (postDict && Number(postDict.id) === id) {
      const item = queue.items.find((entry) => entry.key === key)
      booru.rememberLibraryPost(postDict, { prepend: item?.status === 'done' && !item.duplicate })
    } else {
      rememberById(id)
    }
  }

  // A post known to be in the library without its post object (the swap at
  // Start): fetch it unless the library page already has it.
  async function rememberById(id) {
    if (booru.libraryPostById(id)) return
    try {
      const post = await api.getPost(id)
      if (!disposed && post) booru.rememberLibraryPost(post)
    } catch {
      // The id alone is enough for the id-based batch tools.
    }
  }

  // The card's Start: posts already known to be in the library are swapped
  // now (no download, no merge); the rest go into the queue.
  function enqueueSelected(posts) {
    const fresh = []
    for (const post of Array.isArray(posts) ? posts : [posts]) {
      const existingId = booru.inLibraryPostId(post)
      if (existingId) onImported(post.key, existingId, null)
      else if (post) fresh.push(post)
    }
    return fresh.length ? queue.enqueue(fresh) : []
  }

  const importQueue = { ...queue, enqueue: enqueueSelected }

  // The viewer's Import button: one post, queued and started; the toast
  // reports how it went (the batch panel need not be open).
  async function importFromViewer(post) {
    if (!post?.key) return
    const [added] = queue.enqueue([post])
    if (!added) {
      showMessage('That post is already in the import queue.')
      return
    }
    if (added.status === 'failed') {
      showMessage(added.message, 'error')
      return
    }
    showMessage('Importing 1 post…')
    await queue.start()
    if (disposed) return
    const item = queue.items.find((entry) => entry.key === post.key)
    if (!item || item.status === 'cancelled') return
    showMessage(item.message, item.status === 'failed' ? 'error' : 'success')
  }

  onUnmounted(() => {
    disposed = true
    queue.cancel()
  })

  return { queue, importQueue, importFromViewer, onImported, enqueueSelected }
}
