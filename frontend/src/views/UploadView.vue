<template>
  <div class="upload-view">
    <h1>Upload</h1>

    <RemoteClipEditor ref="remoteClipEditor" />

    <div
      class="drop-zone"
      :class="{ dragging: isDragging, fetching: fetchingUrl || fetchingVideo || fetchingFediverse }"
      @dragover.prevent="isDragging = true"
      @dragleave="isDragging = false"
      @drop.prevent="onDrop"
      @click="$refs.fileInput.click()"
    >
      <input
        ref="fileInput"
        type="file"
        multiple
        accept="image/*,video/webm,video/mp4"
        @change="onFileSelect"
        style="display: none"
      />
      <div class="drop-content">
        <span v-if="fetchingUrl || fetchingVideo || fetchingFediverse" class="drop-icon spinner-icon"></span>
        <span v-else class="drop-icon">&#x1F43E;</span>
        <p v-if="fetchingVideo">Fetching video... hold on, nyaa~</p>
        <p v-else-if="fetchingFediverse">Fetching from fediverse post...</p>
        <p v-else-if="fetchingUrl">Fetching image from URL...</p>
        <p v-else>Drop files here, click to browse, or paste images/URLs</p>
        <p class="hint">Supported: JPG/JFIF, PNG, GIF, WebP, WebM, MP4 + video links (X, YouTube, TikTok, etc.) + Pleroma/Misskey posts</p>
      </div>
    </div>

    <div class="paste-row">
      <button
        type="button"
        class="btn btn-secondary paste-btn"
        @click="pasteFromClipboard"
        :disabled="fetchingUrl || fetchingVideo || fetchingFediverse"
      >
        &#x1F4CB; Paste link or image
      </button>
      <span class="paste-hint">Tap to paste a copied video link or image (handy on mobile)</span>
    </div>

    <div v-if="aiEnabled" class="upload-options">
      <label class="checkbox-row">
        <input type="checkbox" v-model="autoTagUploads" />
        <span>Auto-tag new uploads</span>
      </label>
    </div>

    <!-- Upload Progress Banner -->
    <div v-if="uploadProgress.total > 0" class="progress-banner" :class="{ done: uploadProgress.done }">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>
      <div class="progress-text">
        <span v-if="uploadProgress.done">All uploads complete! Nyaa~</span>
        <span v-else>&#x1F43E; Uploading {{ uploadProgress.current }} of {{ uploadProgress.total }}...</span>
      </div>
    </div>

    <UploadQueue v-if="uploads.length > 0" :queue="queue" :ai="ai" />

    <!-- Success Toast -->
    <div v-if="showSuccessToast" class="toast success">
      {{ successMessage }}
    </div>

    <!-- Warning Toast -->
    <div v-if="showWarningToast" class="toast warning">
      {{ warningMessage }}
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import RemoteClipEditor from '../components/RemoteClipEditor.vue'
import UploadQueue from '../components/upload/UploadQueue.vue'
import { useUploadAiProfiles } from '../composables/useUploadAiProfiles'
import { useUploadQueue } from '../composables/useUploadQueue'
import { useUploadSources } from '../composables/useUploadSources'

const remoteClipEditor = ref(null)
const isDragging = ref(false)

const ai = useUploadAiProfiles()
const { autoTagUploads, aiEnabled, loadAiEnabled } = ai

const queue = useUploadQueue({ autoTagUploads })
const {
  uploads,
  uploadProgress,
  progressPercent,
  showSuccessToast,
  successMessage,
  showWarningToast,
  warningMessage,
  addFiles,
  revokeUploadPreviews,
} = queue

const {
  fetchingUrl,
  fetchingVideo,
  fetchingFediverse,
  handlePaste,
  pasteFromClipboard,
} = useUploadSources({ queue, remoteClipEditor })

// Paste event handler
onMounted(() => {
  document.addEventListener('paste', handlePaste)
  loadAiEnabled()
})

onUnmounted(() => {
  document.removeEventListener('paste', handlePaste)
  revokeUploadPreviews(uploads.value)
})

function onDrop(e) {
  isDragging.value = false
  const files = Array.from(e.dataTransfer.files)
  addFiles(files)
}

function onFileSelect(e) {
  const files = Array.from(e.target.files)
  addFiles(files)
  e.target.value = ''
}
</script>

<style scoped>
.upload-view {
  max-width: 900px;
  margin: 0 auto;
}

.upload-view h1 {
  margin-bottom: 1.5rem;
  color: var(--text-primary);
}

.drop-zone {
  border: 2px dashed var(--accent);
  border-radius: 1rem;
  padding: 3rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: var(--bg-secondary);
}

.drop-zone:hover,
.drop-zone.dragging {
  border-color: var(--coral);
  background: var(--accent-soft);
  transform: scale(1.01);
}

.drop-zone.fetching {
  border-color: var(--accent);
  background: var(--accent-soft);
  pointer-events: none;
}

.drop-icon {
  font-size: 3rem;
  color: var(--accent);
  display: block;
  margin-bottom: 1rem;
}

.drop-icon.spinner-icon {
  display: inline-block;
  width: 3rem;
  height: 3rem;
  border: 4px solid var(--accent);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.drop-content p {
  color: var(--text-secondary);
}

.hint {
  font-size: 0.875rem;
  margin-top: 0.5rem;
}

/* Paste row */
.paste-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
  flex-wrap: wrap;
}

.paste-hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.upload-options {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.checkbox-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-primary);
  font-size: 0.9rem;
}

@media (max-width: 480px) {
  .paste-btn {
    width: 100%;
  }
}

/* Progress Banner */
.progress-banner {
  margin-top: 1.5rem;
  padding: 1rem;
  background: var(--bg-secondary);
  border-radius: 0.5rem;
  border-left: 4px solid var(--accent);
}

.progress-banner.done {
  border-left-color: var(--success);
  background: var(--success-soft);
}

.progress-bar {
  height: 8px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--coral));
  transition: width 0.3s ease;
  border-radius: 4px;
}

.progress-banner.done .progress-fill {
  background: var(--success);
}

.progress-text {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Toast */
.toast {
  position: fixed;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 1rem 2rem;
  border-radius: 0.5rem;
  font-weight: 500;
  z-index: 1000;
  animation: slideUp 0.3s ease;
}

.toast.success {
  background: var(--success);
  color: white;
}

.toast.warning {
  background: var(--warning, #b8860b);
  color: white;
  bottom: 5rem;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(1rem);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
</style>
