// Upload queue state: queued files and remote artifacts, job polling,
// publishing, progress, and the page toasts.
import { ref, computed, reactive } from 'vue'
import api from '../api/client'
import { useTagsStore } from '../stores/tags'

export function getFileIcon(file) {
  if (file.type.startsWith('video/')) return '&#9658;'
  return '?'
}

export function isVideoUpload(upload) {
  const type = upload.file?.type || ''
  const name = upload.file?.name || ''
  return type.startsWith('video/') || /\.(mp4|webm)$/i.test(name)
}
export function useUploadQueue({ autoTagUploads }) {
  const tagsStore = useTagsStore()
  const uploads = ref([])
  const uploading = ref(false)
  const showSuccessToast = ref(false)
  const successMessage = ref('')
  const showWarningToast = ref(false)
  const warningMessage = ref('')
  let uploadIdCounter = 0
  function nextUploadId() {
    return ++uploadIdCounter
  }

  const uploadProgress = reactive({
    current: 0,
    total: 0,
    done: false
  })

  const pendingUploads = computed(() =>
    uploads.value.filter(u => !u.completed && !u.error).length
  )

  const progressPercent = computed(() => {
    if (uploadProgress.total === 0) return 0
    return Math.round((uploadProgress.current / uploadProgress.total) * 100)
  })

  function createQueueUpload(file) {
    return reactive({
      id: ++uploadIdCounter,
      file,
      tags: [],
      safety: 'safe',
      preview: null,
      previewObjectUrl: false,
      uploading: false,
      completed: false,
      error: null,
      aiTagging: false,
      aiProfile: '',
      aiStatus: '',
      aiError: false,
      aiPreviewed: false,
      job: null,
      artifactId: null,
      postId: null,
    })
  }

  async function waitForReady(upload, jobId) {
    while (true) {
      const current = await api.getUploadJob(jobId)
      upload.job = current
      if (['content_ready', 'sample_ready', 'render_ready', 'completed'].includes(current.status)) return current
      if (['failed', 'cancelled', 'interrupted'].includes(current.status)) {
        throw new Error(current.error?.message || current.message)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  async function waitForPublished(upload, jobId, artifactId) {
    while (true) {
      const current = await api.getUploadJob(jobId)
      upload.job = current
      const artifact = current.artifacts?.find(item => item.id === artifactId)
      if (artifact?.metadata?.resultPostId) return artifact.metadata.resultPostId
      if (current.status === 'completed' && current.resultPostId) return current.resultPostId
      if (['failed', 'cancelled', 'interrupted'].includes(current.status)) {
        throw new Error(current.error?.message || current.message)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  async function cancelQueueJob(upload) {
    if (upload.job?.id) upload.job = await api.cancelUploadJob(upload.job.id)
  }

  async function retryQueueJob(upload) {
    if (!upload.job?.id) return
    upload.error = null
    upload.job = await api.retryUploadJob(upload.job.id)
  }

  async function removeQueueJob(upload) {
    if (upload.job?.id) await api.deleteUploadJob(upload.job.id)
    const index = uploads.value.findIndex(item => item.id === upload.id)
    if (index !== -1) removeUpload(index)
  }

  function addFiles(files) {
    for (const file of files) {
      const upload = createQueueUpload(file)

      // Generate preview for images and videos.
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = (e) => {
          upload.preview = e.target.result
        }
        reader.readAsDataURL(file)
      } else if (file.type.startsWith('video/')) {
        upload.preview = URL.createObjectURL(file)
        upload.previewObjectUrl = true
      }

      uploads.value.push(upload)
    }
  }

  function removeUpload(index) {
    const [removed] = uploads.value.splice(index, 1)
    revokeUploadPreviews([removed])
  }

  function clearAll() {
    revokeUploadPreviews(uploads.value)
    uploads.value = []
    uploadProgress.total = 0
    uploadProgress.current = 0
    uploadProgress.done = false
  }

  function revokeUploadPreviews(items) {
    for (const upload of items || []) {
      if (upload?.previewObjectUrl && upload.preview) {
        URL.revokeObjectURL(upload.preview)
        upload.previewObjectUrl = false
      }
    }
  }

  function showToast(message) {
    successMessage.value = message
    showSuccessToast.value = true
    setTimeout(() => {
      showSuccessToast.value = false
    }, 3000)
  }

  function showWarning(message) {
    warningMessage.value = message
    showWarningToast.value = true
    setTimeout(() => {
      showWarningToast.value = false
    }, 5000)
  }

  async function uploadAll() {
    uploading.value = true

    const pending = uploads.value.filter(u => !u.completed && !u.error)
    uploadProgress.total = pending.length
    uploadProgress.current = 0
    uploadProgress.done = false

    let successCount = 0
    let autoTagWarnings = 0

    for (const upload of pending) {
      upload.uploading = true
      uploadProgress.current++

      try {
        let created = null
        if (upload.artifactId && upload.job?.id) {
          upload.job = await api.publishUploadJob(upload.job.id, {
            artifactId: upload.artifactId,
            revision: upload.job.revision,
            tags: upload.tags,
            safety: upload.safety,
            source: upload.source || upload.job.source?.canonicalUrl || null,
            autoTag: autoTagUploads.value && !upload.aiPreviewed,
          }, crypto.randomUUID())
          upload.postId = await waitForPublished(upload, upload.job.id, upload.artifactId)
        } else if (!upload.token) {
          upload.job = await api.createUploadJob({
            kind: 'local',
            filename: upload.file.name,
            size: upload.file.size,
            mimeType: upload.file.type,
          }, crypto.randomUUID())
          upload.job = await api.uploadJobContent(upload.job.id, upload.file, (loaded, total) => {
            const percent = total ? Math.min(99, Math.round(loaded / total * 100)) : 1
            upload.job = {
              ...upload.job,
              status: 'uploading',
              message: 'Uploading local file',
              overallProgress: 10 + Math.round(percent * .8),
              metrics: { downloadedBytes: loaded, totalBytes: total || null },
              stages: (upload.job.stages || []).map(stage => stage.id === 'transfer'
                ? { ...stage, state: 'running', progress: percent, detail: 'Uploading local file' }
                : stage.id === 'validate' ? { ...stage, state: 'completed', progress: 100 } : stage),
            }
          })
          const artifact = upload.job.artifacts.find(item => item.role === 'source')
          if (!artifact) throw new Error('Local upload completed without an artifact.')
          upload.artifactId = artifact.id
          upload.job = await api.publishUploadJob(upload.job.id, {
            artifactId: artifact.id,
            revision: upload.job.revision,
            tags: upload.tags,
            safety: upload.safety,
            source: upload.source || null,
            autoTag: autoTagUploads.value && !upload.aiPreviewed,
          }, crypto.randomUUID())
          upload.postId = await waitForPublished(upload, upload.job.id, artifact.id)
        } else {
          const meta = tagsStore.tagMetadataFor(upload.tags)
          created = await api.createPost({
            contentToken: upload.token,
            tags: upload.tags,
            safety: upload.safety,
            source: upload.source || null,
            autoTag: autoTagUploads.value && !upload.aiPreviewed,
            tagCategories: meta.categories,
            tagDisplayNames: meta.displayNames,
          })
          upload.postId = created?.id
        }
        if (created?.autoTagWarning) autoTagWarnings++

        upload.completed = true
        successCount++

      } catch (e) {
        upload.error = e.message
      } finally {
        upload.uploading = false
      }
    }

    uploading.value = false
    uploadProgress.done = true

    if (successCount > 0) {
      showToast(`Successfully uploaded ${successCount} file${successCount > 1 ? 's' : ''}!`)
    }

    if (autoTagWarnings > 0) {
      showWarning(`AI worker offline — ${autoTagWarnings} file${autoTagWarnings > 1 ? 's' : ''} saved without tags.`)
    }

    // Clear progress after a delay
    setTimeout(() => {
      if (uploadProgress.done) {
        uploadProgress.total = 0
        uploadProgress.current = 0
        uploadProgress.done = false
      }
    }, 3000)
  }
  return {
    uploads,
    uploading,
    uploadProgress,
    pendingUploads,
    progressPercent,
    showSuccessToast,
    successMessage,
    showWarningToast,
    warningMessage,
    showToast,
    showWarning,
    getFileIcon,
    isVideoUpload,
    nextUploadId,
    createQueueUpload,
    waitForReady,
    waitForPublished,
    cancelQueueJob,
    retryQueueJob,
    removeQueueJob,
    addFiles,
    removeUpload,
    clearAll,
    revokeUploadPreviews,
    uploadAll,
  }
}
