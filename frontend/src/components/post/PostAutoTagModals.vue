<template>
  <div v-if="showAutoTagModal" class="modal-overlay" @click.self="showAutoTagModal = false">
    <div class="modal auto-tag-preview-modal">
      <h2>AI Tag Preview</h2>
      <p v-if="autoTagTimingLabel" class="auto-timing">Completed in {{ autoTagTimingLabel }}</p>
      <div class="auto-tag-preview-body">
        <div v-if="autoTagSuggestion?.error" class="auto-error">
          {{ autoTagSuggestion.error }}
        </div>
        <div v-else>
          <div class="safety-review">
            <div>
              <strong>Safety rating</strong>
              <small>Suggested by the model. You can override before applying.</small>
            </div>
            <div class="safety-choice-group">
              <button
                v-for="safety in safetyOptions"
                :key="safety.value"
                type="button"
                class="safety-choice"
                :class="[safety.value, { active: autoTagEditedSafety === safety.value }]"
                @click="autoTagEditedSafety = safety.value"
              >
                <span></span>{{ safety.label }}
              </button>
            </div>
          </div>
          <TagInput v-model="autoTagEditedTags" />
          <label v-if="autoTagHasSemanticEvidence" class="save-analysis-toggle">
            <input type="checkbox" v-model="saveSemanticAnalysisForPreview" />
            <span>
              <strong>Save Qwen semantic analysis</strong>
              <small>Stores rationale, semantic tags, raw output, and timing so semantic search can find this post by phrases.</small>
            </span>
          </label>
          <div v-if="autoTagSemanticPreview" class="semantic-preview-card">
            <div class="semantic-preview-head">
              <div>
                <strong>Semantic Analysis</strong>
                <small>{{ autoTagSemanticPreview.model }}{{ autoTagSemanticPreview.timing ? ` · ${autoTagSemanticPreview.timing}` : '' }}</small>
              </div>
              <span v-if="autoTagSemanticPreview.safety">{{ autoTagSemanticPreview.safety }}</span>
            </div>
            <p>{{ autoTagSemanticPreview.rationale || autoTagSemanticPreview.summary || autoTagSemanticPreview.raw }}</p>
            <div v-if="autoTagSemanticPreview.tags.length" class="semantic-preview-tags">
              <span v-for="tag in autoTagSemanticPreview.tags" :key="tag">{{ tag }}</span>
            </div>
          </div>
          <div v-if="autoTagEvidenceModels.length" class="auto-evidence">
            <h3>Model Evidence</h3>
            <div v-for="(model, index) in autoTagEvidenceModels" :key="index" class="evidence-card">
              <div class="evidence-head">
                <strong>{{ model.model || 'Unknown model' }}</strong>
                <span v-if="model.error" class="evidence-error">{{ model.error }}</span>
              </div>
              <dl>
                <template v-for="item in evidenceRows(model)" :key="item.label">
                  <dt>{{ item.label }}</dt>
                  <dd>{{ item.value }}</dd>
                </template>
              </dl>
            </div>
            <details v-if="autoTagEvidenceRaw" class="raw-evidence">
              <summary>Raw evidence</summary>
              <pre>{{ autoTagEvidenceRaw }}</pre>
            </details>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" @click="showAutoTagModal = false">Cancel</button>
        <button v-if="autoTagSuggestion?.error" class="btn" @click="router.push('/settings')">
          Open Settings
        </button>
        <button v-else class="btn" @click="applyAutoTags" :disabled="autoTagLoading || !hasAutoTagChanges">
          Apply
        </button>
      </div>
    </div>
  </div>

  <div v-if="showAutoProcessModal" class="modal-overlay">
    <div class="modal ai-process-modal">
      <h2>{{ autoTagStageTitle }}</h2>
      <p class="auto-summary">
        {{ autoTagStageMessage }}
      </p>
      <div class="auto-progress">
        <div class="auto-progress-fill" :style="{ width: autoTagOverallProgress + '%' }"></div>
      </div>
      <p class="auto-load-meta">
        {{ autoTagOverallProgress }}% · elapsed {{ autoTagRunElapsed }}s · {{ autoTagEstimateLabel }}
      </p>
      <div class="ai-process-steps">
        <div
          v-for="step in autoTagProcessSteps"
          :key="step.key"
          class="ai-process-step"
          :class="step.state"
        >
          <span class="step-dot"></span>
          <div>
            <strong>{{ step.label }}</strong>
            <small>{{ step.detail }}</small>
          </div>
        </div>
      </div>
      <div v-if="selectedAutoTagModelRows.length" class="ai-selected-models">
        <strong>Selected models</strong>
        <ul>
          <li v-for="model in selectedAutoTagModelRows" :key="model.id">
            <span>{{ model.name }}</span>
            <small>
              {{ model.loaded ? 'loaded' : model.downloaded ? 'ready to load' : 'not downloaded' }}
              · {{ model.vramRequirement || 'VRAM varies' }}
            </small>
          </li>
        </ul>
      </div>
      <p v-if="autoLoadJob?.error" class="auto-load-error">
        {{ autoLoadJob.error }}
      </p>
      <p class="auto-load-meta">
        First loads read model weights from disk. Qwen and multi-model previews can take several minutes on CPU or when offloading.
      </p>
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import TagInput from '../TagInput.vue'
import { evidenceRows } from '../../composables/usePostPageAiAnalysis'

const props = defineProps({
  // The object returned by usePostPageAutoTag().
  autoTag: {
    type: Object,
    required: true,
  },
})

const router = useRouter()
const {
  safetyOptions,
  showAutoTagModal,
  showAutoProcessModal,
  autoTagTimingLabel,
  autoTagSuggestion,
  autoTagEditedSafety,
  autoTagEditedTags,
  autoTagHasSemanticEvidence,
  saveSemanticAnalysisForPreview,
  autoTagSemanticPreview,
  autoTagEvidenceModels,
  autoTagEvidenceRaw,
  autoTagLoading,
  hasAutoTagChanges,
  autoTagStageTitle,
  autoTagStageMessage,
  autoTagOverallProgress,
  autoTagRunElapsed,
  autoTagEstimateLabel,
  autoTagProcessSteps,
  selectedAutoTagModelRows,
  autoLoadJob,
  applyAutoTags,
} = props.autoTag
</script>

<style scoped src="./postModal.css"></style>

<style scoped>
.save-analysis-toggle {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.65rem;
  align-items: start;
  margin: 0.9rem 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
}

.save-analysis-toggle small {
  display: block;
  margin-top: 0.2rem;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.auto-tag-preview-modal {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: min(470px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  padding: 0;
  overflow: hidden;
}

.auto-tag-preview-modal h2 {
  margin: 0;
  padding: 1.25rem 1.25rem 0.35rem;
}

.auto-tag-preview-modal .auto-timing {
  margin: 0;
  padding: 0 1.25rem 0.75rem;
}

.auto-tag-preview-body {
  min-height: 0;
  overflow-y: auto;
  padding: 0 1.25rem 1rem;
}

.auto-tag-preview-modal .modal-actions {
  position: sticky;
  bottom: 0;
  margin: 0;
  padding: 0.9rem 1.25rem 1.25rem;
  border-top: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(17, 24, 39, 0.92), var(--bg-primary) 35%);
}

.auto-tag-preview-modal h2 {
  margin-bottom: 0;
}

.auto-timing {
  margin: -0.8rem 0 1rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.auto-summary {
  margin-bottom: 0.75rem;
  color: var(--text-secondary);
}

.ai-process-modal {
  width: 520px;
}

.ai-process-steps {
  display: grid;
  gap: 0.65rem;
  margin: 1rem 0;
}

.ai-process-step {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.7rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.ai-process-step strong {
  display: block;
  color: var(--text-primary);
  font-size: 0.86rem;
  margin-bottom: 0.15rem;
}

.ai-process-step small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.step-dot {
  width: 11px;
  height: 11px;
  margin-top: 0.2rem;
  border-radius: 999px;
  background: var(--border);
  box-shadow: 0 0 0 4px rgba(148, 163, 184, 0.08);
}

.ai-process-step.active .step-dot {
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.ai-process-step.completed .step-dot {
  background: #4ade80;
  box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.13);
}

.ai-process-step.failed .step-dot {
  background: #f87171;
  box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.14);
}

.ai-selected-models {
  padding: 0.8rem;
  margin-top: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.ai-selected-models > strong {
  display: block;
  margin-bottom: 0.55rem;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.ai-selected-models ul {
  display: grid;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-selected-models li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  color: var(--text-primary);
  font-size: 0.8rem;
}

.ai-selected-models small {
  color: var(--text-secondary);
  text-align: right;
}

.safety-review {
  display: grid;
  gap: 0.75rem;
  padding: 0.85rem;
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.safety-review strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 0.15rem;
}

.safety-review small {
  color: var(--text-secondary);
}

.safety-choice-group {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.safety-choice {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 38px;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-weight: 600;
  font-size: 0.82rem;
}

.safety-choice span {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.safety-choice.safe span {
  background: #4ade80;
}

.safety-choice.sketchy span {
  background: #facc15;
}

.safety-choice.unsafe span {
  background: #f87171;
}

.safety-choice.active {
  color: var(--text-primary);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.auto-error {
  padding: 0.75rem;
  background: var(--coral-soft);
  border: 1px solid var(--coral);
  border-radius: 0.5rem;
  color: var(--text-primary);
}

.semantic-preview-card {
  display: grid;
  gap: 0.65rem;
  margin-top: 1rem;
  padding: 0.85rem;
  border: 1px solid rgba(96, 165, 250, 0.38);
  border-radius: 0.55rem;
  background: rgba(96, 165, 250, 0.08);
}

.semantic-preview-head {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  justify-content: space-between;
}

.semantic-preview-head div {
  display: grid;
  gap: 0.15rem;
}

.semantic-preview-head strong {
  color: var(--text-primary);
}

.semantic-preview-head small {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.semantic-preview-head span {
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
}

.semantic-preview-card p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.86rem;
  line-height: 1.45;
}

.semantic-preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.semantic-preview-tags span {
  padding: 0.2rem 0.4rem;
  border: 1px solid rgba(96, 165, 250, 0.48);
  border-radius: 0.35rem;
  color: var(--accent);
  font-size: 0.72rem;
}

.auto-evidence {
  margin-top: 1rem;
  max-height: 240px;
  overflow: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem;
}

.auto-evidence h3 {
  margin: 0 0 0.65rem;
  color: var(--text-primary);
  font-size: 0.9rem;
}

.evidence-card {
  padding: 0.75rem;
  margin-bottom: 0.6rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 0.45rem;
}

.evidence-card:last-of-type {
  margin-bottom: 0;
}

.evidence-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
  color: var(--text-primary);
}

.evidence-error {
  color: var(--coral);
  font-size: 0.78rem;
}

.evidence-card dl {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 0.45rem 0.75rem;
  margin: 0;
}

.evidence-card dt {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.evidence-card dd {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.raw-evidence {
  margin-top: 0.75rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.raw-evidence summary {
  cursor: pointer;
}

.raw-evidence pre {
  margin: 0.5rem 0 0;
  padding: 0.75rem;
  max-height: 180px;
  overflow: auto;
  color: #f3f4f6;
  background: #111827;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  white-space: pre-wrap;
  font-size: 0.75rem;
}

.auto-progress {
  height: 10px;
  background: var(--bg-secondary);
  border-radius: 5px;
  overflow: hidden;
  margin: 1rem 0 0.5rem;
}

.auto-progress.compact {
  height: 7px;
  margin: 0 0 0.45rem;
  background: rgba(148, 163, 184, 0.18);
}

.auto-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}

.auto-load-meta {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin: 0.4rem 0;
}

.auto-load-error {
  padding: 0.65rem 0.75rem;
  color: #fecaca;
  background: rgba(127, 29, 29, 0.28);
  border: 1px solid rgba(248, 113, 113, 0.55);
  border-radius: 0.45rem;
  font-size: 0.82rem;
  line-height: 1.45;
  white-space: pre-wrap;
}

@media (max-width: 768px) {
  .auto-tag-preview-modal {
    width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  .auto-tag-preview-body {
    overflow-y: auto;
  }

  .auto-tag-preview-modal h2 {
    margin-bottom: 0;
  }

  .auto-tag-preview-modal .modal-actions {
    flex-direction: column;
    margin: 0;
  }
}
</style>
