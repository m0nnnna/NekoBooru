<template>
  <div v-if="showPreviewModal" class="modal-overlay" @click.self="showPreviewModal = false">
    <div class="preview-modal">
      <div class="modal-head">
        <div>
          <h2>Preview Suggestions</h2>
          <p>{{ previewSuggestions.length }} suggestion{{ previewSuggestions.length === 1 ? '' : 's' }} from job #{{ autoTagJob?.id }}</p>
        </div>
        <button class="btn btn-secondary" @click="showPreviewModal = false">Close</button>
      </div>
      <div v-if="previewLoading" class="stats-loading">Loading suggestions...</div>
      <div v-else-if="!previewSuggestions.length" class="empty-preview">
        No saved suggestions found for this preview job.
      </div>
      <div v-else class="preview-list">
        <div v-for="suggestion in previewSuggestions" :key="suggestion.id" class="preview-row">
          <div class="preview-row-head">
            <strong>Post #{{ suggestion.postId }}</strong>
            <span :class="suggestion.error ? 'model-missing' : 'model-ok'">{{ suggestion.error ? 'error' : suggestion.status }}</span>
          </div>
          <div class="preview-tags">
            <span v-for="tag in suggestion.suggestedTags.slice(0, 18)" :key="tag">{{ tag }}</span>
            <em v-if="suggestion.suggestedTags.length > 18">+{{ suggestion.suggestedTags.length - 18 }} more</em>
          </div>
          <p>
            Safety: <strong>{{ suggestion.suggestedSafety || 'unchanged' }}</strong>
            <span v-if="suggestion.error"> · {{ suggestion.error }}</span>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsBulkJob().
  bulk: {
    type: Object,
    required: true,
  },
})

const { autoTagJob, showPreviewModal, previewSuggestions, previewLoading } = props.bulk
</script>
<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(5, 8, 13, 0.72);
  backdrop-filter: blur(4px);
}

.preview-modal {
  width: min(920px, calc(100vw - 2rem));
  max-height: min(760px, calc(100vh - 2rem));
  overflow: auto;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-secondary);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.42);
}

.modal-head {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.modal-head h2 {
  margin: 0 0 0.25rem;
}

.modal-head p {
  margin: 0;
  color: var(--text-secondary);
}

.empty-preview {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
}

.preview-list {
  display: grid;
  gap: 0.75rem;
}

.preview-row {
  display: grid;
  gap: 0.65rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.preview-row-head {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
}

.preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.preview-tags span,
.preview-tags em {
  padding: 0.25rem 0.45rem;
  border: 1px solid var(--accent);
  border-radius: 0.35rem;
  background: rgba(96, 165, 250, 0.12);
  color: var(--accent);
  font-size: 0.78rem;
  font-style: normal;
  line-height: 1.2;
}

.preview-row p {
  margin: 0;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .modal-head {
    flex-direction: column;
  }
}
</style>
