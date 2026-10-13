<template>
  <div v-if="batchOptimizeConfirmOpen" class="modal-overlay" @click.self="batchOptimizeConfirmOpen = false">
    <div class="modal batch-optimize-confirm" role="dialog" aria-modal="true" aria-labelledby="batch-optimize-confirm-title">
      <div class="batch-optimize-confirm-head">
        <span aria-hidden="true">!</span>
        <div>
          <h3 id="batch-optimize-confirm-title">
            {{ batchOptimizeApplyMode === 'create' ? 'Create new posts from reviewed media?' : 'Apply reviewed media replacements?' }}
          </h3>
          <p>
            The exact {{ batchOptimizePreview?.optimized || 0 }} preview file{{ batchOptimizePreview?.optimized === 1 ? '' : 's' }}
            you reviewed will be used. No second encode is performed.
          </p>
        </div>
      </div>
      <div class="batch-optimize-apply-mode" role="radiogroup" aria-label="Reviewed media destination">
        <label :class="{ active: batchOptimizeApplyMode === 'replace' }">
          <input v-model="batchOptimizeApplyMode" type="radio" value="replace" />
          <span>
            <strong>Replace selected posts</strong>
            <small>Updates each original post with its exact reviewed preview.</small>
          </span>
        </label>
        <label :class="{ active: batchOptimizeApplyMode === 'create' }">
          <input v-model="batchOptimizeApplyMode" type="radio" value="create" />
          <span>
            <strong>Create new posts</strong>
            <small>Keeps originals untouched and copies each post’s tags, safety, and source.</small>
          </span>
        </label>
      </div>
      <div class="batch-optimize-confirm-metrics">
        <div>
          <span>Before</span>
          <strong>{{ formatFileSize(batchOptimizePreviewSavings.before) }}</strong>
        </div>
        <div>
          <span>After</span>
          <strong>{{ formatFileSize(batchOptimizePreviewSavings.after) }}</strong>
        </div>
        <div>
          <span>{{ batchOptimizeIsSocial ? 'Storage change' : 'Reduction' }}</span>
          <strong>{{ batchOptimizeConfirmStorageChange }}</strong>
        </div>
      </div>
      <p class="batch-optimize-confirm-note">
        <template v-if="batchOptimizeApplyMode === 'create'">
          Each reviewed artifact becomes a separate post after its source version and content hash are revalidated.
        </template>
        <template v-else>
          Each reviewed artifact is revalidated against its source post and content hash before replacement.
        </template>
      </p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" @click="batchOptimizeConfirmOpen = false" :disabled="busy">Cancel</button>
        <button
          type="button"
          class="btn"
          :class="{ 'btn-danger': batchOptimizeApplyMode === 'replace' }"
          @click="confirmBatchMediaOptimize"
          :disabled="busy"
        >
          {{ busy ? 'Applying...' : batchOptimizeApplyMode === 'create' ? 'Create New Posts' : 'Replace Reviewed Originals' }}
        </button>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="batchOptimizePreviewItem?.previewUrl"
      class="batch-optimize-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="Batch optimized media preview"
    >
      <MediaViewer
        :src="batchOptimizePreviewItem.previewUrl"
        :alt="`Optimized preview of post ${batchOptimizePreviewItem.postId}`"
        :type="batchOptimizePreviewMediaType"
        @close="batchOptimizePreviewItem = null"
      />
      <div class="batch-optimize-preview-banner">
        <span>
          {{ batchOptimizePreviewItem.status === 'preview' ? 'Optimized preview' : 'Current file retained' }}
          · Post #{{ batchOptimizePreviewItem.postId }}
        </span>
        <strong>
          {{ formatFileSize(batchOptimizePreviewItem.oldSize) }} → {{ formatFileSize(batchOptimizePreviewItem.newSize) }}
        </strong>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import MediaViewer from '../MediaViewer.vue'
import { formatFileSize } from '../../utils/format'

const props = defineProps({
  // The object returned by useBatchMediaOptimize().
  optimizer: {
    type: Object,
    required: true,
  },
  busy: {
    type: Boolean,
    default: false,
  },
})

const {
  batchOptimizeConfirmOpen,
  batchOptimizeApplyMode,
  batchOptimizePreview,
  batchOptimizePreviewSavings,
  batchOptimizeIsSocial,
  batchOptimizeConfirmStorageChange,
  batchOptimizePreviewItem,
  batchOptimizePreviewMediaType,
  confirmBatchMediaOptimize,
} = props.optimizer
</script>

<style scoped>
.batch-optimize-confirm-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.5rem;
}

.batch-optimize-confirm-metrics > div {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
  padding: 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
}

.batch-optimize-confirm-metrics span {
  color: var(--text-secondary);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.035em;
  text-transform: uppercase;
}

.batch-optimize-confirm-metrics strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-optimize-confirm {
  width: min(590px, calc(100vw - 2rem));
}

.batch-optimize-confirm-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: flex-start;
  gap: 0.8rem;
}

.batch-optimize-confirm-head > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--coral-soft);
  color: var(--coral);
  font-weight: 900;
}

.batch-optimize-confirm-head h3 {
  color: var(--text-primary);
}

.batch-optimize-confirm-head p,
.batch-optimize-confirm-note {
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.45;
}

.batch-optimize-confirm-metrics {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 1rem;
}

.batch-optimize-apply-mode {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
  margin-top: 1rem;
}

.batch-optimize-apply-mode label {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: var(--bg-secondary);
  cursor: pointer;
}

.batch-optimize-apply-mode label.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent);
}

.batch-optimize-apply-mode input {
  margin-top: 0.2rem;
}

.batch-optimize-apply-mode span {
  display: grid;
  gap: 0.2rem;
}

.batch-optimize-apply-mode strong {
  color: var(--text-primary);
  font-size: 0.8rem;
}

.batch-optimize-apply-mode small {
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.4;
}

.batch-optimize-confirm-metrics > div:last-child {
  border-color: rgba(129, 178, 154, 0.55);
  background: var(--success-soft);
}

.batch-optimize-confirm-metrics > div:last-child strong {
  color: var(--success);
}

.batch-optimize-confirm-note {
  margin-top: 0.8rem;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--bg-secondary);
}

.batch-optimize-confirm .modal-actions {
  margin-top: 1rem;
}

.batch-optimize-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 3000;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: #000;
}

.batch-optimize-fullscreen :deep(.media-viewer) {
  border-radius: 0;
  background: #000;
}

.batch-optimize-preview-banner {
  position: fixed;
  top: 1rem;
  left: 1rem;
  z-index: 3010;
  display: grid;
  max-width: min(420px, calc(100vw - 6rem));
  gap: 0.1rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 0.6rem;
  background: rgba(8, 12, 18, 0.82);
  color: white;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  pointer-events: none;
}

.batch-optimize-preview-banner span {
  color: rgba(255, 255, 255, 0.65);
  font-size: 0.67rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.batch-optimize-preview-banner strong {
  font-size: 0.78rem;
}

@media (max-width: 768px) {
  .batch-optimize-confirm-metrics,
  .batch-optimize-apply-mode {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped src="./batchModal.css"></style>
