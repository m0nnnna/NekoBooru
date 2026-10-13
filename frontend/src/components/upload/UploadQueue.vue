<template>
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
          <video
            v-if="upload.preview && isVideoUpload(upload)"
            :src="upload.preview"
            muted
            playsinline
            preload="metadata"
          ></video>
          <img v-else-if="upload.preview" :src="upload.preview" />
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
          <div v-if="aiEnabled" class="upload-ai-panel">
            <div class="upload-ai-actions" aria-label="AI tag preview profiles">
              <button
                v-for="profile in aiProfiles"
                :key="profile.id"
                type="button"
                class="btn btn-secondary ai-profile-btn"
                :class="{ active: upload.aiProfile === profile.id }"
                :disabled="upload.completed || upload.uploading || upload.aiTagging || uploading"
                :data-tooltip="profile.tooltip"
                @click="previewUploadAiTags(upload, profile.id)"
              >
                {{ upload.aiTagging && upload.aiProfile === profile.id ? 'Running...' : profile.label }}
              </button>
            </div>
            <div v-if="upload.aiStatus" class="upload-ai-status" :class="{ error: upload.aiError }">
              {{ upload.aiStatus }}
            </div>
          </div>
          <UploadJobProgress
            v-if="upload.job"
            :job="upload.job"
            compact
            actions
            @cancel="cancelQueueJob(upload)"
            @retry="retryQueueJob(upload)"
            @remove="removeQueueJob(upload)"
          />
        </div>
        <div class="upload-status">
          <div v-if="upload.uploading" class="status uploading">
            <span class="spinner"></span>
            Uploading...
          </div>
          <div v-else-if="upload.completed" class="status completed">
            <span class="checkmark">&#10003;</span>
            Done!
            <router-link v-if="upload.postId" :to="`/post/${upload.postId}`">Open post</router-link>
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
</template>

<script setup>
import TagInput from '../TagInput.vue'
import UploadJobProgress from '../UploadJobProgress.vue'

const props = defineProps({
  // The object returned by useUploadQueue().
  queue: {
    type: Object,
    required: true,
  },
  // The object returned by useUploadAiProfiles().
  ai: {
    type: Object,
    required: true,
  },
})

const {
  uploads,
  uploading,
  pendingUploads,
  getFileIcon,
  isVideoUpload,
  cancelQueueJob,
  retryQueueJob,
  removeQueueJob,
  removeUpload,
  clearAll,
  uploadAll,
} = props.queue
const { aiEnabled, aiProfiles, previewUploadAiTags } = props.ai
</script>

<style scoped>
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

.preview img,
.preview video {
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

.upload-ai-panel {
  display: grid;
  gap: 0.45rem;
}

.upload-ai-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
}

.ai-profile-btn {
  position: relative;
  min-width: 0;
  padding: 0.5rem 0.45rem;
  font-size: 0.78rem;
  line-height: 1.2;
  white-space: normal;
}

.ai-profile-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.ai-profile-btn::after {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 80;
  display: block;
  width: max-content;
  max-width: min(340px, 78vw);
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.38);
  content: attr(data-tooltip);
  font-size: 0.74rem;
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.ai-profile-btn:hover::after,
.ai-profile-btn:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

.upload-ai-status {
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.upload-ai-status.error {
  border-color: rgba(235, 139, 114, 0.5);
  color: var(--coral);
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
</style>
