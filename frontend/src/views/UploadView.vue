<template>
  <div class="upload-view">
    <h1>Upload</h1>

    <div
      class="drop-zone"
      :class="{ dragging: isDragging, fetching: fetchingUrl || fetchingVideo }"
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
        <span v-if="fetchingUrl || fetchingVideo" class="drop-icon spinner-icon"></span>
        <span v-else class="drop-icon">+</span>
        <p v-if="fetchingVideo">Downloading video... (this may take a moment)</p>
        <p v-else-if="fetchingUrl">Fetching image from URL...</p>
        <p v-else>Drop files here, click to browse, or paste images/URLs</p>
        <p class="hint">Supported: JPG, PNG, GIF, WebP, WebM, MP4 + video links (X, YouTube, TikTok, etc.)</p>
      </div>
    </div>

    <!-- Upload Progress Banner -->
    <div v-if="uploadProgress.total > 0" class="progress-banner" :class="{ done: uploadProgress.done }">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>
      <div class="progress-text">
        <span v-if="uploadProgress.done">All uploads complete!</span>
        <span v-else>Uploading {{ uploadProgress.current }} of {{ uploadProgress.total }}...</span>
      </div>
    </div>

    <div v-if="uploads.length > 0" class="upload-queue">
      <div class="queue-header">
        <h2>Queue ({{ pendingUploads }} pending)</h2>
        <div class="queue-actions">
          <button class="btn btn-secondary" @click="clearAll" :disabled="uploading">
            Clear All
          </button>
          <button
            class="btn"
            @click="uploadAll"
            :disabled="uploading || pendingUploads === 0"
          >
            {{ uploading ? 'Uploading...' : `Upload All (${pendingUploads})` }}
          </button>
        </div>
      </div>

      <div class="upload-list">
        <div
          v-for="(upload, index) in uploads"
          :key="upload.id"
          class="upload-item"
          :class="{
            completed: upload.completed,
            error: upload.error,
            uploading: upload.uploading
          }"
        >
          <div class="preview">
            <img v-if="upload.preview" :src="upload.preview" />
            <span v-else class="no-preview">{{ getFileIcon(upload.file) }}</span>
          </div>
          <div class="upload-details">
            <div class="filename">{{ upload.file.name }}</div>
            <TagInput
              v-model="upload.tags"
              placeholder="Add tags (comma separated)..."
              :disabled="upload.completed || upload.uploading"
            />
            <div class="safety-row">
              <label>Rating:</label>
              <select v-model="upload.safety" :disabled="upload.completed || upload.uploading">
                <option value="safe">Safe</option>
                <option value="sketchy">Sketchy</option>
                <option value="unsafe">Unsafe</option>
              </select>
            </div>
          </div>
          <div class="upload-status">
            <div v-if="upload.uploading" class="status uploading">
              <span class="spinner"></span>
              Uploading...
            </div>
            <div v-else-if="upload.completed" class="status completed">
              <span class="checkmark">&#10003;</span>
              Done!
            </div>
            <div v-else-if="upload.error" class="status error">
              <span class="error-icon">&#10007;</span>
              {{ upload.error }}
            </div>
            <button
              v-else
              class="btn btn-secondary btn-sm"
              @click="removeUpload(index)"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Success Toast -->
    <div v-if="showSuccessToast" class="toast success">
      {{ successMessage }}
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api/client'
import TagInput from '../components/TagInput.vue'

const router = useRouter()

const isDragging = ref(false)
const uploads = ref([])
const uploading = ref(false)
const showSuccessToast = ref(false)
const successMessage = ref('')
const fetchingUrl = ref(false)
const fetchingVideo = ref(false)
let uploadIdCounter = 0

// Paste event handler
onMounted(() => {
  document.addEventListener('paste', handlePaste)
})

onUnmounted(() => {
  document.removeEventListener('paste', handlePaste)
})

async function handlePaste(e) {
  // Don't intercept paste events in input fields
  const activeElement = document.activeElement
  if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
    return
  }

  const clipboardData = e.clipboardData
  if (!clipboardData) return

  // Check for pasted files/images
  const files = Array.from(clipboardData.files)
  if (files.length > 0) {
    e.preventDefault()
    addFiles(files)
    return
  }

  // Check for image items (screenshots, copied images)
  for (const item of clipboardData.items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const blob = item.getAsFile()
      if (blob) {
        // Create a File with a generated name
        const ext = item.type.split('/')[1] || 'png'
        const filename = `pasted-image-${Date.now()}.${ext}`
        const file = new File([blob], filename, { type: item.type })
        addFiles([file])
      }
      return
    }
  }

  // Check for pasted URL text
  const text = clipboardData.getData('text/plain')?.trim()
  if (text) {
    if (isVideoUrl(text)) {
      e.preventDefault()
      await fetchFromYtdlp(text)
    } else if (isImageUrl(text)) {
      e.preventDefault()
      await fetchFromUrl(text)
    }
  }
}

function isVideoUrl(text) {
  // Check if text looks like a URL to a video platform (for yt-dlp)
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return false

    // Video platform domains that yt-dlp handles well
    const videoPlatforms = [
      'twitter.com', 'x.com',
      'youtube.com', 'youtu.be', 'www.youtube.com',
      'tiktok.com', 'www.tiktok.com',
      'instagram.com', 'www.instagram.com',
      'reddit.com', 'www.reddit.com', 'old.reddit.com',
      'vimeo.com',
      'twitch.tv', 'clips.twitch.tv',
      'dailymotion.com',
      'streamable.com',
      'v.redd.it',
    ]

    // Check if it's a video platform URL
    if (videoPlatforms.some(domain => url.host === domain || url.host.endsWith('.' + domain))) {
      // For instagram, only match reels and posts with video
      if (url.host.includes('instagram.com')) {
        return url.pathname.includes('/reel/') || url.pathname.includes('/p/')
      }
      // For reddit, match video posts
      if (url.host.includes('reddit.com') || url.host === 'v.redd.it') {
        return true
      }
      return true
    }

    return false
  } catch {
    return false
  }
}

function isImageUrl(text) {
  // Check if text looks like a URL to an image/video file (direct links)
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return false

    // Check common image/video extensions (direct file links)
    const ext = url.pathname.split('.').pop()?.toLowerCase()
    const mediaExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'webm', 'mp4']
    if (mediaExts.includes(ext)) return true

    // Check common image hosting domains (direct image links)
    const imageHosts = [
      'i.imgur.com', 'imgur.com',
      'i.redd.it', 'preview.redd.it',
      'pbs.twimg.com', 'media.tumblr.com',
      'cdn.discordapp.com', 'media.discordapp.net',
      'i.pinimg.com', 'i.pximg.net',
      'gelbooru.com', 'safebooru.org', 'danbooru.donmai.us',
    ]
    if (imageHosts.some(host => url.host.includes(host))) return true

    return false
  } catch {
    return false
  }
}

async function fetchFromUrl(url) {
  fetchingUrl.value = true
  showToast('Fetching image from URL...')

  try {
    const result = await api.uploadFromUrl(url)

    // Create a pseudo-upload entry
    const upload = reactive({
      id: ++uploadIdCounter,
      file: { name: result.filename, size: result.size, type: 'image/*' },
      tags: [],
      safety: 'safe',
      preview: url, // Use URL as preview
      uploading: false,
      completed: false,
      error: null,
      token: result.token, // Pre-uploaded token
    })

    uploads.value.push(upload)
    showToast('Image fetched successfully!')
  } catch (e) {
    showToast('Failed to fetch image: ' + e.message)
  } finally {
    fetchingUrl.value = false
  }
}

async function fetchFromYtdlp(url) {
  fetchingVideo.value = true
  showToast('Downloading video...')

  try {
    const result = await api.uploadFromYtdlp(url)

    // Create a pseudo-upload entry with video info
    const upload = reactive({
      id: ++uploadIdCounter,
      file: { name: result.filename, size: 0, type: 'video/mp4' },
      tags: [],
      safety: 'safe',
      preview: result.thumbnail || null, // Use yt-dlp thumbnail
      uploading: false,
      completed: false,
      error: null,
      token: result.token, // Pre-uploaded token
      videoInfo: {
        title: result.title,
        duration: result.duration,
        uploader: result.uploader,
      },
    })

    uploads.value.push(upload)

    // Show success with video title
    const title = result.title?.length > 50 ? result.title.slice(0, 50) + '...' : result.title
    showToast(`Video downloaded: ${title}`)
  } catch (e) {
    showToast('Failed to download video: ' + e.message)
  } finally {
    fetchingVideo.value = false
  }
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

function getFileIcon(file) {
  if (file.type.startsWith('video/')) return '&#9658;'
  return '?'
}

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

function addFiles(files) {
  for (const file of files) {
    const upload = reactive({
      id: ++uploadIdCounter,
      file,
      tags: [],
      safety: 'safe',
      preview: null,
      uploading: false,
      completed: false,
      error: null,
    })

    // Generate preview for images
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (e) => {
        upload.preview = e.target.result
      }
      reader.readAsDataURL(file)
    }

    uploads.value.push(upload)
  }
}

function removeUpload(index) {
  uploads.value.splice(index, 1)
}

function clearAll() {
  uploads.value = []
  uploadProgress.total = 0
  uploadProgress.current = 0
  uploadProgress.done = false
}

function showToast(message) {
  successMessage.value = message
  showSuccessToast.value = true
  setTimeout(() => {
    showSuccessToast.value = false
  }, 3000)
}

async function uploadAll() {
  uploading.value = true

  const pending = uploads.value.filter(u => !u.completed && !u.error)
  uploadProgress.total = pending.length
  uploadProgress.current = 0
  uploadProgress.done = false

  let successCount = 0

  for (const upload of pending) {
    upload.uploading = true
    uploadProgress.current++

    try {
      let token = upload.token // May already have token from URL fetch

      // Step 1: Upload file (skip if already has token from URL fetch)
      if (!token) {
        const result = await api.uploadFile(upload.file)
        token = result.token
      }

      // Step 2: Create post
      await api.createPost({
        contentToken: token,
        tags: upload.tags,
        safety: upload.safety,
      })

      upload.completed = true
      successCount++

      // Auto-remove completed after a short delay
      setTimeout(() => {
        const idx = uploads.value.findIndex(u => u.id === upload.id)
        if (idx !== -1 && uploads.value[idx].completed) {
          uploads.value.splice(idx, 1)
        }
      }, 1500)

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

  // Clear progress after a delay
  setTimeout(() => {
    if (uploadProgress.done) {
      uploadProgress.total = 0
      uploadProgress.current = 0
      uploadProgress.done = false
    }
  }, 3000)
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

/* Queue */
.upload-queue {
  margin-top: 2rem;
}

.queue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.queue-header h2 {
  margin: 0;
}

.queue-actions {
  display: flex;
  gap: 0.5rem;
}

.upload-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.upload-item {
  display: grid;
  grid-template-columns: 100px 1fr auto;
  gap: 1rem;
  padding: 1rem;
  background: var(--bg-secondary);
  border-radius: 0.75rem;
  align-items: start;
  border: 2px solid transparent;
  transition: all 0.3s;
}

.upload-item.uploading {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.upload-item.completed {
  border-color: var(--success);
  background: var(--success-soft);
  opacity: 0.8;
}

.upload-item.error {
  border-color: var(--coral);
  background: var(--coral-soft);
}

.preview {
  width: 100px;
  height: 100px;
  background: var(--bg-tertiary);
  border-radius: 0.5rem;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.no-preview {
  color: var(--text-secondary);
  font-size: 2rem;
}

.upload-details {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.filename {
  font-weight: 600;
  word-break: break-all;
  color: var(--text-primary);
}

.safety-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.safety-row label {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.safety-row select {
  width: fit-content;
}

.upload-status {
  display: flex;
  align-items: flex-start;
  min-width: 120px;
}

.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
}

.status.uploading {
  color: var(--accent);
}

.status.completed {
  color: var(--success);
}

.status.error {
  color: var(--coral);
  flex-direction: column;
  align-items: flex-start;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--accent);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.checkmark {
  font-size: 1.25rem;
}

.error-icon {
  font-size: 1.25rem;
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
