import { onUnmounted, watch } from 'vue'
import { api as defaultApi } from '../api/client'
import { ADAPTERS } from '../remote/adapters/index.js'
import { useImportQueue } from '../remote/useImportQueue.js'
import { isAutoJobRunning } from './useBatchOperations'
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
export function useHomeImport({ booru, selection, showMessage = () => {}, operations = null, api = defaultApi, adapters = ADAPTERS }) {
  let disposed = false

  const queue = useImportQueue({
    api,
    adapters,
    inLibrary: booru.results.lookup,
    onImported,
  })

  trackInBatchStatus(queue, operations)

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

export const IMPORT_STATUS_TITLE = 'Importing from boorus'

function importSummary({ done = 0, total = 0, failed = 0, skipped = 0 } = {}) {
  let text = `${done} of ${total} imported`
  if (skipped) text += `, ${skipped} already in the library`
  if (failed) text += `, ${failed} failed`
  return text
}

// The batch panel's status strip follows a queue run (plan section 4.4): it
// begins when the queue starts, moves as items settle, and completes when the
// queue stops. It only writes while the import still owns the strip, so a
// batch edit started meanwhile keeps its own status.
function trackInBatchStatus(queue, operations) {
  if (!operations) return
  const owns = () => operations.batchOperation?.value?.title === IMPORT_STATUS_TITLE
  // Never take the strip from an AI job being polled or another running action.
  const busyElsewhere = () => isAutoJobRunning(operations.batchAutoJob?.value)
    || (operations.batchOperation?.value?.status === 'running' && !owns())
  watch(
    [() => queue.running.value, () => queue.progress.value],
    ([running, progress], [wasRunning]) => {
      const settled = progress.done + progress.failed + progress.skipped
      if (running && !wasRunning) {
        if (busyElsewhere()) return
        operations.beginBatchOperation(IMPORT_STATUS_TITLE, importSummary(progress), progress.total)
      } else if (running && owns()) {
        const percent = progress.total ? Math.round((settled / progress.total) * 100) : 0
        operations.updateBatchOperation(importSummary(progress), Math.min(99, percent))
      } else if (!running && wasRunning && owns()) {
        if (progress.failed && !progress.done && !progress.skipped) operations.failBatchOperation(importSummary(progress))
        else operations.completeBatchOperation(importSummary(progress), progress.total)
      }
    },
  )
}
