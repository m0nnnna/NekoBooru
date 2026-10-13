import { ref, onUnmounted } from 'vue'
import { api } from '../api/client'

const AUTO_JOB_ACTIVE = ['queued', 'running', 'cancelling']

export function isAutoJobRunning(job) {
  return Boolean(job && AUTO_JOB_ACTIVE.includes(job.status))
}

// Shared progress state for whatever batch action is running on the
// selection: a synchronous-ish operation (tag update, pool add, delete,
// optimize) or a backend AI auto-tag job that is polled until it finishes.
// Also owns the `busy` flag and the transient toast message.
export function useBatchOperations({ selectedCount, selectMode, fetchPosts }) {
  const busy = ref(false)
  const actionMessage = ref('')
  const actionMessageKind = ref('success')
  const batchAutoJob = ref(null)
  const batchOperation = ref(null)
  let actionMessageTimer = null
  let batchAutoPollTimer = null

  function showMessage(text, kind = 'success') {
    actionMessage.value = text
    actionMessageKind.value = kind
    if (actionMessageTimer) clearTimeout(actionMessageTimer)
    actionMessageTimer = setTimeout(() => {
      actionMessage.value = ''
    }, 5000)
  }

  function beginBatchOperation(title, detail, total = selectedCount()) {
    batchAutoJob.value = null
    stopBatchAutoPolling()
    batchOperation.value = {
      title,
      detail,
      total,
      progress: 12,
      status: 'running',
    }
  }

  function updateBatchOperation(detail, progress) {
    if (!batchOperation.value) return
    batchOperation.value = {
      ...batchOperation.value,
      detail,
      progress: Math.max(batchOperation.value.progress || 0, progress),
    }
  }

  function completeBatchOperation(detail, total = batchOperation.value?.total || selectedCount()) {
    if (!batchOperation.value) return
    batchOperation.value = {
      ...batchOperation.value,
      detail,
      total,
      progress: 100,
      status: 'completed',
    }
  }

  function failBatchOperation(detail) {
    batchOperation.value = {
      ...(batchOperation.value || { title: 'Batch operation', total: selectedCount() }),
      detail,
      status: 'failed',
      progress: Math.max(batchOperation.value?.progress || 0, 100),
    }
  }

  function stopBatchAutoPolling() {
    if (batchAutoPollTimer) {
      clearInterval(batchAutoPollTimer)
      batchAutoPollTimer = null
    }
  }

  function startBatchAutoPolling() {
    stopBatchAutoPolling()
    if (!batchAutoJob.value?.id) return
    batchAutoPollTimer = setInterval(refreshBatchAutoJob, 1500)
  }

  // Hand a freshly created backend auto-tag job over to the status area.
  function trackAutoJob(job) {
    batchOperation.value = null
    batchAutoJob.value = job
    startBatchAutoPolling()
  }

  async function refreshBatchAutoJob() {
    if (!batchAutoJob.value?.id) return
    try {
      batchAutoJob.value = await api.getAutoTagJob(batchAutoJob.value.id)
      if (!isAutoJobRunning(batchAutoJob.value)) {
        stopBatchAutoPolling()
        if (!batchAutoJob.value.dryRun && !selectMode.value) await fetchPosts()
      }
    } catch (e) {
      stopBatchAutoPolling()
      failBatchOperation(`Failed to refresh AI job status: ${e.message}`)
    }
  }

  async function cancelBatchAutoTag() {
    if (!batchAutoJob.value?.id) return
    try {
      batchAutoJob.value = await api.cancelAutoTagJob(batchAutoJob.value.id)
      startBatchAutoPolling()
    } catch (e) {
      showMessage(`Cancel failed: ${e.message}`, 'error')
    }
  }

  onUnmounted(() => {
    stopBatchAutoPolling()
    if (actionMessageTimer) clearTimeout(actionMessageTimer)
  })

  return {
    busy,
    actionMessage,
    actionMessageKind,
    batchAutoJob,
    batchOperation,
    showMessage,
    beginBatchOperation,
    updateBatchOperation,
    completeBatchOperation,
    failBatchOperation,
    trackAutoJob,
    cancelBatchAutoTag,
  }
}
