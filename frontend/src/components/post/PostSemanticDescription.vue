<template>
  <div v-if="semanticSidebarAnalysis" class="sidebar-section semantic-description-section">
    <h3>Semantic Description</h3>
    <div class="semantic-description-card">
      <div class="semantic-description-meta">
        <div>
          <strong>{{ semanticSidebarAnalysis.model }}</strong>
          <small>{{ semanticSidebarAnalysis.profile }}{{ semanticSidebarAnalysis.timing ? ` · ${semanticSidebarAnalysis.timing}` : '' }}</small>
        </div>
        <button
          v-if="editingAiAnalysisId !== semanticSidebarAnalysis.id"
          type="button"
          class="semantic-description-edit"
          @click="startEditAiAnalysis(semanticSidebarAnalysis)"
        >
          Edit
        </button>
      </div>
      <template v-if="editingAiAnalysisId === semanticSidebarAnalysis.id">
        <textarea
          v-model="aiAnalysisDescriptionDraft"
          class="semantic-description-editor"
          rows="8"
          spellcheck="true"
        ></textarea>
        <div class="semantic-description-actions">
          <button
            type="button"
            class="link-btn"
            @click="cancelEditAiAnalysis"
            :disabled="savingAiAnalysis"
          >
            Cancel
          </button>
          <button
            type="button"
            class="link-btn primary"
            @click="saveAiAnalysisDescription(semanticSidebarAnalysis)"
            :disabled="savingAiAnalysis"
          >
            {{ savingAiAnalysis ? 'Saving...' : 'Save' }}
          </button>
        </div>
        <small v-if="aiAnalysisEditError" class="saved-analysis-error">{{ aiAnalysisEditError }}</small>
      </template>
      <template v-else>
        <p>{{ semanticSidebarAnalysis.description }}</p>
      </template>
      <div v-if="semanticSidebarAnalysis.tags.length" class="semantic-description-tags">
        <span v-for="tag in semanticSidebarAnalysis.tags" :key="tag">{{ tag }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by usePostPageAiAnalysis().
  analysis: {
    type: Object,
    required: true,
  },
})

const {
  semanticSidebarAnalysis,
  editingAiAnalysisId,
  aiAnalysisDescriptionDraft,
  savingAiAnalysis,
  aiAnalysisEditError,
  startEditAiAnalysis,
  cancelEditAiAnalysis,
  saveAiAnalysisDescription,
} = props.analysis
</script>

<style scoped>
.sidebar-section h3 {
  font-size: 0.75rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 0.75rem;
  font-weight: 600;
}

.saved-analysis-card {
  padding: 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.saved-analysis-card + .saved-analysis-card {
  margin-top: 0.5rem;
}

.saved-analysis-card summary {
  display: grid;
  gap: 0.15rem;
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 700;
}

.saved-analysis-card summary small {
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 500;
}

.saved-analysis-body {
  display: grid;
  gap: 0.55rem;
  margin-top: 0.65rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.4;
}

.saved-analysis-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.saved-analysis-tags span {
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--accent);
  border-radius: 0.35rem;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.72rem;
}

.saved-analysis-body pre {
  max-height: 140px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0.55rem;
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 0.72rem;
}

.saved-analysis-editor {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  line-height: 1.45;
}

.saved-analysis-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.45rem;
}

.saved-analysis-edit {
  justify-self: start;
}

.saved-analysis-error {
  color: var(--coral);
}

.semantic-description-card {
  display: grid;
  gap: 0.65rem;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.semantic-description-meta {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.semantic-description-meta > div {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}

.semantic-description-meta strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.semantic-description-meta small {
  color: var(--text-secondary);
  font-size: 0.72rem;
  white-space: nowrap;
}

.semantic-description-card p {
  max-height: 170px;
  margin: 0;
  overflow: auto;
  padding-right: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.45;
}

.semantic-description-edit {
  flex: 0 0 auto;
  padding: 0.18rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.78rem;
  line-height: 1.1;
}

.semantic-description-edit:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.semantic-description-editor {
  width: 100%;
  min-height: 145px;
  resize: vertical;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  line-height: 1.45;
}

.semantic-description-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.semantic-description-actions .link-btn.primary {
  color: var(--accent);
  font-weight: 700;
}

.semantic-description-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.semantic-description-tags span {
  padding: 0.16rem 0.4rem;
  border: 1px solid rgba(96, 165, 250, 0.55);
  border-radius: 0.35rem;
  background: rgba(96, 165, 250, 0.12);
  color: var(--accent);
  font-size: 0.7rem;
}

@media (max-width: 768px) {
  .sidebar-section h3 {
    font-size: 0.7rem;
    margin-bottom: 0.5rem;
  }
}
</style>
