<template>
  <Teleport to="body">
    <div
      v-if="optimizePreviewOpen && optimizePreview?.previewUrl"
      class="optimize-preview-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="Optimized media preview"
    >
      <MediaViewer
        :src="optimizePreview.previewUrl"
        :alt="`Optimized preview of ${post.filename}`"
        :type="optimizePreviewMediaType"
        @close="closeOptimizePreview"
      />
      <div class="optimize-preview-banner">
        <span>{{ optimizePreviewIsSocial ? 'Social-compatible MP4 preview' : optimizePreviewCanApply ? 'Temporary optimized preview' : 'Current file preview' }}</span>
        <strong>{{ optimizePreviewAssessment }} · {{ optimizePreviewDimensionSummary }}</strong>
      </div>
    </div>
  </Teleport>

  <div v-if="showOptimizeConfirm" class="modal-overlay" @click.self="showOptimizeConfirm = false">
    <div class="modal optimize-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="optimize-confirm-title">
      <div class="optimize-confirm-heading">
        <span class="optimize-confirm-mark" aria-hidden="true">!</span>
        <div>
          <h2 id="optimize-confirm-title">
            {{ postOptimizeApplyMode === 'create' ? 'Create a new post?' : 'Replace the stored original?' }}
          </h2>
          <p>
            The exact preview you reviewed will be used. No second encode is performed.
          </p>
        </div>
      </div>
      <div class="optimize-apply-mode" role="radiogroup" aria-label="Reviewed media destination">
        <label :class="{ active: postOptimizeApplyMode === 'replace' }">
          <input v-model="postOptimizeApplyMode" type="radio" value="replace" />
          <span>
            <strong>Replace this post</strong>
            <small>Updates the existing media while retaining this post’s metadata and relationships.</small>
          </span>
        </label>
        <label :class="{ active: postOptimizeApplyMode === 'create' }">
          <input v-model="postOptimizeApplyMode" type="radio" value="create" />
          <span>
            <strong>Create new post</strong>
            <small>Keeps this post untouched and copies its {{ post.tags.length }} tag{{ post.tags.length === 1 ? '' : 's' }}, safety, and source.</small>
          </span>
        </label>
      </div>
      <div class="optimize-confirm-impact">
        <div>
          <span>Current file</span>
          <strong>{{ formatFileSize(optimizePreviewSavings.before) }}</strong>
        </div>
        <div>
          <span>Reviewed output</span>
          <strong>{{ formatFileSize(optimizePreviewSavings.after) }}</strong>
        </div>
        <div class="positive">
          <span>{{ optimizePreviewIsSocial ? 'Storage change' : 'Storage reduction' }}</span>
          <strong>{{ optimizeConfirmStorageChange }}</strong>
        </div>
      </div>
      <div class="optimize-confirm-note">
        <template v-if="postOptimizeApplyMode === 'create'">
          NekoBooru creates a separate post after revalidating the reviewed bytes. The current post remains unchanged.
        </template>
        <template v-else>
          NekoBooru revalidates the reviewed bytes, content hash, and source version before replacing the original.
        </template>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" @click="showOptimizeConfirm = false" :disabled="optimizeBusy">Cancel</button>
        <button
          class="btn"
          :class="{ 'btn-danger': postOptimizeApplyMode === 'replace' }"
          @click="confirmOptimizeCurrentPost"
          :disabled="optimizeBusy"
        >
          {{ optimizeBusy ? 'Applying...' : postOptimizeApplyMode === 'create' ? 'Create New Post' : 'Replace Original' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import MediaViewer from '../MediaViewer.vue'
import { formatFileSize } from '../../composables/usePostPageFormat'

const props = defineProps({
  post: {
    type: Object,
    required: true,
  },
  // The object returned by usePostPageOptimize().
  optimize: {
    type: Object,
    required: true,
  },
})

const {
  optimizePreview,
  optimizePreviewOpen,
  optimizePreviewMediaType,
  optimizePreviewIsSocial,
  optimizePreviewCanApply,
  optimizePreviewAssessment,
  optimizePreviewDimensionSummary,
  optimizePreviewSavings,
  optimizeConfirmStorageChange,
  showOptimizeConfirm,
  postOptimizeApplyMode,
  optimizeBusy,
  closeOptimizePreview,
  confirmOptimizeCurrentPost,
} = props.optimize
</script>

<style scoped>
.optimize-context-card span,
.optimize-review-metrics span,
.optimize-confirm-impact span {
  color: var(--text-secondary);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.optimize-review-metrics,
.optimize-confirm-impact {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
}

.optimize-review-metrics > div,
.optimize-confirm-impact > div {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
}

.optimize-review-metrics strong,
.optimize-confirm-impact strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.77rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.optimize-preview-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 3000;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: #000;
}

.optimize-preview-fullscreen :deep(.media-viewer) {
  border-radius: 0;
  background: #000;
}

.optimize-preview-banner {
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

.optimize-preview-banner span {
  color: rgba(255, 255, 255, 0.65);
  font-size: 0.67rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.optimize-preview-banner strong {
  font-size: 0.78rem;
}

.optimize-confirm-modal {
  width: min(560px, calc(100vw - 2rem));
}

.optimize-confirm-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.8rem;
  align-items: flex-start;
}

.optimize-confirm-heading h2 {
  margin: 0;
  font-size: 1.05rem;
}

.optimize-confirm-heading p {
  margin-top: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.45;
}

.optimize-confirm-mark {
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

.optimize-confirm-impact {
  margin-top: 1rem;
}

.optimize-apply-mode {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
  margin-top: 1rem;
}

.optimize-apply-mode label {
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

.optimize-apply-mode label.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent);
}

.optimize-apply-mode input {
  margin-top: 0.2rem;
}

.optimize-apply-mode span {
  display: grid;
  gap: 0.2rem;
}

.optimize-apply-mode strong {
  color: var(--text-primary);
  font-size: 0.8rem;
}

.optimize-apply-mode small {
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.4;
}

.optimize-confirm-impact .positive {
  border-color: rgba(129, 178, 154, 0.55);
  background: var(--success-soft);
}

.optimize-confirm-impact .positive strong {
  color: var(--success);
}

.optimize-confirm-note {
  margin-top: 0.8rem;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.45;
}

.optimize-confirm-modal .modal-actions {
  margin-top: 1rem;
}

@media (max-width: 768px) {
  .optimize-context-grid,
  .optimize-review-metrics,
  .optimize-confirm-impact,
  .optimize-apply-mode {
    grid-template-columns: 1fr;
  }
}
</style>

<!-- After the dialog rules on purpose: on the post page .modal came later and won. -->
<style scoped src="./postModal.css"></style>
