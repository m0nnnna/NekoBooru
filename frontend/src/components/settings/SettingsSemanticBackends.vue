<template>
  <div v-if="semanticModels.length" class="semantic-manager">
    <div class="semantic-manager-head">
      <div>
        <h4>Qwen Semantic Backend</h4>
        <p>Choose one Qwen backend for higher-level context, political/edit tags, and multimodal evidence.</p>
      </div>
      <span class="semantic-selected-pill">{{ selectedSemanticModel?.name || 'No backend selected' }}</span>
    </div>

    <label class="pipeline-toggle semantic-default-toggle">
      <input type="checkbox" v-model="autoTagSettings.qwenEnabled" />
      <span>
        <strong>Enable semantic tags by default</strong>
        <small>Uses the selected Qwen backend during imports, per-post AI Tag, extension previews, and bulk jobs.</small>
      </span>
    </label>

    <div class="semantic-backend-grid">
      <div
        v-for="model in semanticModels"
        :key="model.id"
        class="semantic-model-card"
        :class="{ active: autoTagSettings.semanticModelId === model.id }"
      >
        <div class="semantic-model-head">
          <label class="semantic-model-choice">
            <input type="radio" :value="model.id" v-model="autoTagSettings.semanticModelId" />
            <span>
              <strong>{{ model.name }}</strong>
              <code>{{ model.repoId }}</code>
            </span>
          </label>
          <span :class="model.downloaded ? 'model-ok' : 'model-missing'">
            {{ model.downloaded ? 'Downloaded' : 'Not downloaded' }}
          </span>
        </div>
        <p>{{ model.purpose }}</p>
        <small>{{ semanticBackendDescription(model) }}</small>
        <div class="model-facts compact">
          <span><strong>Size</strong>{{ model.downloadSize || 'Unknown' }}</span>
          <span><strong>VRAM</strong>{{ model.vramRequirement || 'Unknown' }}</span>
          <span :class="model.runtimeAvailable ? 'model-ok' : 'model-missing'">
            <strong>Runtime</strong>{{ model.runtimeAvailable ? 'Ready' : 'Missing' }}
          </span>
          <span :class="model.loaded ? 'model-ok' : 'model-missing'">
            <strong>Memory</strong>{{ model.loaded ? 'Loaded' : 'Not loaded' }}
          </span>
        </div>
        <div v-if="modelDownloadState(model.id)" class="model-progress compact-progress">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: modelProgressPercent(model.id) + '%' }"></div>
          </div>
          <p>
            <strong>{{ modelProgressPercent(model.id) }}%</strong>
            {{ modelDownloadStateLabel(model.id) }}
            <span v-if="modelDownloadState(model.id).current">: {{ modelDownloadState(model.id).current }}</span>
            <span v-if="modelDownloadBytes(model.id)"> - {{ modelDownloadBytes(model.id) }}</span>
          </p>
          <p v-if="modelDownloadState(model.id).error" class="stats-error">{{ modelDownloadState(model.id).error }}</p>
        </div>
        <div class="model-actions compact-actions">
          <button
            class="btn btn-secondary"
            :class="{ 'btn-danger': modelDownloadRunningFor(model.id) }"
            @click="modelDownloadRunningFor(model.id) ? cancelModelDownload() : downloadAutoTagModelById(model.id)"
            :disabled="modelDownloadCancelling || model.downloaded || modelDownloadQueuedFor(model.id)"
          >
            {{ modelDownloadButtonLabel(model) }}
          </button>
          <button
            class="btn btn-secondary"
            @click="model.loaded ? unloadAutoTagModelById(model.id) : loadAutoTagModelById(model.id)"
            :disabled="modelDownloadActiveFor(model.id) || !model.downloaded || !model.runtimeAvailable || modelMemoryBusy || modelLoadQueuedFor(model.id)"
          >
            {{ modelLoadButtonLabel(model) }}
          </button>
          <button
            class="btn btn-danger"
            @click="deleteAutoTagModelById(model.id)"
            :disabled="modelDownloadActiveFor(model.id) || !model.downloaded || modelDeleteBusy"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="semantic-prompt-panel semantic-prompt-standalone">
    <div class="semantic-prompt-head">
      <div>
        <strong>Semantic prompt</strong>
        <small>Customize what the selected Qwen backend should look for and which tags it should return.</small>
      </div>
      <div class="semantic-prompt-actions">
        <button
          type="button"
          class="btn btn-secondary btn-small"
          title="Restore the built-in NekoBooru semantic prompt"
          @click="resetSemanticPrompt"
        >
          Restore Default Prompt
        </button>
        <button
          type="button"
          class="btn btn-small"
          title="Save only the semantic prompt and related semantic options"
          @click="saveSemanticPrompt"
          :disabled="savingAutoTags"
        >
          {{ savingAutoTags ? 'Saving...' : 'Save Prompt' }}
        </button>
      </div>
    </div>
    <div class="semantic-option-grid">
      <label class="pipeline-toggle">
        <input type="checkbox" v-model="autoTagSettings.semanticPromptEnabled" />
        <span>
          <strong>Use saved semantic prompt</strong>
          <small>When enabled, Qwen uses the prompt below. When disabled, it falls back to NekoBooru's built-in default prompt.</small>
        </span>
      </label>
      <label class="pipeline-toggle">
        <input type="checkbox" v-model="autoTagSettings.semanticSearchEnabled" />
        <span>
          <strong>Semantic search</strong>
          <small>Searches tags plus saved Qwen semantic analysis so phrases can match model rationale, summaries, and semantic tags.</small>
        </span>
      </label>
      <label class="pipeline-toggle">
        <input type="checkbox" v-model="autoTagSettings.saveSemanticAnalysis" />
        <span>
          <strong>Save Qwen analysis when applying</strong>
          <small>Stores semantic tags, safety, rationale, prompt hash, timings, and raw Qwen output for app, import, and bulk auto-tagging.</small>
        </span>
      </label>
    </div>
    <textarea
      v-model="autoTagSettings.semanticPrompt"
      rows="7"
      maxlength="4000"
      spellcheck="true"
      :disabled="autoTagSettings.semanticPromptEnabled === false"
      placeholder="Describe the semantic tags Qwen should look for..."
    ></textarea>
    <small class="semantic-prompt-note">
      Used when semantic tags are enabled for per-post, import, extension preview, or bulk auto-tagging. Keep requested tags in snake_case for best results.
    </small>
    <p
      v-if="semanticPromptStatus.show"
      class="cookies-status compact-status"
      :class="semanticPromptStatus.success ? 'success' : 'error'"
    >
      <strong>{{ semanticPromptStatus.message }}</strong>
    </p>
  </div>
</template>

<script setup>
import { semanticBackendDescription } from '../../composables/useSettingsAiModels'

const props = defineProps({
  // The object returned by useSettingsAutoTag().
  autoTag: {
    type: Object,
    required: true,
  },
  // The object returned by useSettingsModels().
  models: {
    type: Object,
    required: true,
  },
})

const {
  autoTagSettings,
  savingAutoTags,
  semanticPromptStatus,
  resetSemanticPrompt,
  saveSemanticPrompt,
} = props.autoTag

const {
  modelMemoryBusy,
  modelDeleteBusy,
  modelDownloadCancelling,
  semanticModels,
  selectedSemanticModel,
  downloadAutoTagModelById,
  loadAutoTagModelById,
  unloadAutoTagModelById,
  deleteAutoTagModelById,
  cancelModelDownload,
  modelDownloadState,
  modelDownloadActiveFor,
  modelDownloadRunningFor,
  modelDownloadQueuedFor,
  modelDownloadButtonLabel,
  modelLoadQueuedFor,
  modelLoadButtonLabel,
  modelProgressPercent,
  modelDownloadStateLabel,
  modelDownloadBytes,
} = props.models
</script>
<style scoped>
.help-text code {
  background: var(--bg-secondary);
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.8rem;
}

.semantic-manager {
  display: grid;
  gap: 0.85rem;
  margin-top: 1rem;
  padding: 0.95rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 0.55rem;
}

.semantic-manager-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.semantic-manager-head h4 {
  margin: 0 0 0.2rem;
  color: var(--text-primary);
  font-size: 0.96rem;
}

.semantic-manager-head p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
  line-height: 1.35;
}

.semantic-selected-pill {
  flex: 0 0 auto;
  padding: 0.28rem 0.5rem;
  border: 1px solid var(--accent);
  border-radius: 0.45rem;
  background: rgba(96, 165, 250, 0.1);
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 700;
}

.semantic-default-toggle {
  margin-top: 0;
  background: rgba(255, 255, 255, 0.025);
}

.semantic-backend-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
}

.semantic-model-card {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.9fr) auto;
  gap: 0.55rem;
  align-items: start;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--bg-secondary);
}

.semantic-model-card.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.22);
}

.semantic-model-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  grid-column: 1;
  grid-row: 1;
}

.semantic-model-choice {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 0.55rem;
  align-items: flex-start;
  min-width: 0;
  margin: 0;
  color: var(--text-primary);
  cursor: pointer;
}

.semantic-model-choice input {
  margin-top: 0.2rem;
}

.semantic-model-choice strong,
.semantic-model-choice code {
  display: block;
}

.semantic-model-choice code {
  margin-top: 0.15rem;
  color: var(--text-secondary);
  font-size: 0.74rem;
  white-space: normal;
  overflow-wrap: anywhere;
}

.semantic-model-card p,
.semantic-model-card small {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.semantic-model-card > p,
.semantic-model-card > small {
  grid-column: 1;
}

.semantic-model-card > p {
  grid-row: 2;
}

.semantic-model-card > small {
  grid-row: 3;
}

.semantic-model-card .model-facts {
  grid-column: 2;
  grid-row: 1 / 4;
  margin-top: 0;
}

.semantic-model-card .model-progress {
  grid-column: 1 / -1;
  grid-row: 4;
}

.semantic-model-card .model-actions {
  grid-column: 3;
  grid-row: 1 / 4;
  flex-direction: column;
  align-items: stretch;
  min-width: 112px;
  margin-top: 0;
}

.semantic-model-card .model-actions .btn {
  width: 100%;
}

.semantic-prompt-standalone {
  margin-top: 0.9rem;
  background: var(--bg-primary);
}

.semantic-option-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.model-facts.compact {
  grid-template-columns: repeat(auto-fit, minmax(105px, 1fr));
  gap: 0.4rem;
}

.semantic-prompt-panel {
  display: grid;
  gap: 0.6rem;
  width: 100%;
  margin-top: 0.35rem;
  padding: 0.8rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.45rem;
}

.semantic-prompt-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
  color: var(--text-primary);
}

.semantic-prompt-head strong {
  display: block;
  margin-bottom: 0.15rem;
  font-size: 0.88rem;
}

.semantic-prompt-head small,
.semantic-prompt-note {
  display: block;
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.35;
}

.semantic-prompt-actions {
  display: grid;
  gap: 0.45rem;
  justify-items: stretch;
  min-width: 160px;
}

.semantic-prompt-actions .btn {
  width: 100%;
}

.semantic-prompt-panel textarea {
  width: 100%;
  min-height: 320px;
  max-height: 72vh;
  resize: both;
  font-family: inherit;
  font-size: 0.84rem;
  line-height: 1.45;
}

.semantic-prompt-panel textarea:disabled {
  opacity: 0.62;
  cursor: not-allowed;
}

.btn-small {
  padding: 0.4rem 0.65rem;
  font-size: 0.8rem;
}

.compact-progress {
  margin-top: 0.25rem;
}

.compact-actions {
  margin-top: 0.25rem;
  flex-wrap: wrap;
}

.compact-actions .btn {
  padding: 0.45rem 0.7rem;
}

@media (max-width: 768px) {
  .config-panel-head,
  .semantic-manager-head,
  .pipeline-head {
    flex-direction: column;
  }

  .config-panel-head p,
  .pipeline-models {
    max-width: none;
    text-align: left;
  }

  .semantic-model-card {
    grid-template-columns: 1fr;
  }

  .semantic-model-card .model-facts,
  .semantic-model-card .model-actions,
  .semantic-model-card .model-progress,
  .semantic-model-card > p,
  .semantic-model-card > small,
  .semantic-model-head {
    grid-column: 1;
  }

  .semantic-model-card .model-actions {
    flex-direction: row;
  }

  .semantic-model-card .model-actions .btn {
    width: auto;
  }
}
</style>
