<template>
  <div v-if="aiRuntimeMissing" class="ai-setup-panel">
    <div class="config-panel-head">
      <h3>Set up the AI runtime</h3>
      <p>
        AI tagging needs an extra ML runtime that is not bundled with the base installer.
        Pick a local CPU/GPU runtime or configure a remote server AI worker.
      </p>
    </div>
    <div class="ai-setup-target ai-profile-grid">
      <label v-for="profile in aiRuntimeProfileRows" :key="profile.id" class="radio-row">
        <input type="radio" :value="profile.id" v-model="selectedAiRuntimeProfile" />
        <span>
          <strong>{{ profile.label }}</strong>
          <small>{{ profile.description }}</small>
          <em>{{ profile.downloadSize }} · {{ profile.vram }}</em>
        </span>
      </label>
    </div>
    <div class="ai-setup-command">
      <code>{{ aiSetupCommand }}</code>
      <button class="btn btn-secondary" @click="copyAiSetupCommand">
        {{ aiSetupCopied ? 'Copied!' : 'Copy' }}
      </button>
    </div>
    <div v-if="aiRuntimeJob" class="download-summary">
      <div class="download-summary-head">
        <strong>{{ aiRuntimeJob.message || aiRuntimeJob.status }}</strong>
        <span>{{ aiRuntimeInstallProgress }}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: aiRuntimeInstallProgress + '%' }"></div>
      </div>
      <p>{{ aiRuntimeJob.status }} · {{ aiRuntimeJob.profile }}</p>
      <details v-if="aiRuntimeJob.output">
        <summary>Installer output</summary>
        <pre>{{ aiRuntimeJob.output }}</pre>
      </details>
    </div>
    <div v-if="aiRuntimeMessage.show" class="cookies-status" :class="aiRuntimeMessage.success ? 'success' : 'error'">
      <p><strong>{{ aiRuntimeMessage.message }}</strong></p>
    </div>
    <div class="form-actions">
      <button class="btn" @click="startAiRuntimeInstall" :disabled="aiRuntimeBusy">
        {{ aiRuntimeBusy ? 'Installing...' : 'Install Selected Runtime' }}
      </button>
      <button class="btn btn-secondary" @click="cancelAiRuntimeInstall" :disabled="!aiRuntimeBusy">
        Cancel Install
      </button>
      <button class="btn" @click="recheckAiRuntime" :disabled="recheckingRuntime">
        {{ recheckingRuntime ? 'Checking...' : 'Re-check runtime' }}
      </button>
      <span class="status-note">
        Torch {{ effectiveTorch.version || 'not installed' }} ·
        ONNX runtime {{ effectiveOnnxReady ? 'ready' : 'missing' }}
      </span>
    </div>
  </div>

  <div class="auto-status">
    <div class="pipeline-head">
      <div>
        <strong>Pipeline:</strong>
        <span :class="autoTagStatus.enabled ? 'model-ok' : 'model-missing'">
          {{ autoTagStatus.enabled ? 'Enabled' : 'Disabled' }}
        </span>
      </div>
      <div class="pipeline-models">
        {{ enabledModelNames || 'No models enabled' }}
      </div>
    </div>
    <div class="pipeline-grid">
      <div>
        <span>Downloaded</span>
        <strong>{{ downloadedModelCount }} / {{ modelCatalog.length }}</strong>
      </div>
      <div>
        <span>Loaded</span>
        <strong>{{ loadedModelCount }} / {{ modelCatalog.length }}</strong>
      </div>
      <div>
        <span>Runtime</span>
        <strong :class="missingRuntimeModels.length ? 'model-missing' : 'model-ok'">
          {{ missingRuntimeModels.length ? `${missingRuntimeModels.length} missing` : 'Ready' }}
        </strong>
      </div>
      <div>
        <span>Compute</span>
        <strong :class="effectiveTorch.cudaAvailable ? 'model-ok' : 'model-missing'">
          {{ torchSummary }}
        </strong>
      </div>
      <div>
        <span>Video support</span>
        <strong :class="autoTagStatus.ffmpeg ? 'model-ok' : 'model-missing'">
          {{ autoTagStatus.ffmpeg ? 'ffmpeg ready' : 'ffmpeg missing' }}
        </strong>
      </div>
      <div>
        <span>Hugging Face token</span>
        <strong>{{ autoTagStatus.huggingFaceTokenConfigured ? 'Configured' : 'Not configured' }}</strong>
      </div>
      <div>
        <span>Active defaults</span>
        <strong>{{ enabledModels.length }} model{{ enabledModels.length === 1 ? '' : 's' }}</strong>
      </div>
    </div>
    <p v-if="enabledModelsMissingDownloads.length" class="status-note warning">
      Enabled but not downloaded: {{ enabledModelsMissingDownloads.map(model => model.name).join(', ') }}
    </p>
    <p v-if="missingRuntimeModels.length" class="status-note warning">
      Missing runtime packages: {{ missingRuntimeModels.map(model => model.name).join(', ') }}
    </p>
    <p class="status-note">
      Torch {{ effectiveTorch.version || 'unknown' }} · {{ torchDeviceDetail }}
    </p>
  </div>

  <div class="form-group">
    <label>Hugging Face token</label>
    <div class="path-input-group">
      <input
        v-model="huggingFaceToken"
        type="password"
        placeholder="Paste a token for private/gated models"
        autocomplete="off"
        class="path-input"
      />
      <button class="btn btn-secondary" @click="saveHuggingFaceToken" :disabled="savingToken || !huggingFaceToken.trim()">
        {{ savingToken ? 'Saving...' : 'Save Token' }}
      </button>
      <button class="btn btn-secondary" @click="deleteHuggingFaceToken" :disabled="savingToken || !autoTagStatus.huggingFaceTokenConfigured">
        Forget
      </button>
    </div>
    <p class="help-text">
      Stored locally in NekoBooru config and used only for Hugging Face model downloads.
    </p>
  </div>

  <div v-if="modelStatusMessage.show" class="cookies-status" :class="modelStatusMessage.success ? 'success' : 'error'">
    <p><strong>{{ modelStatusMessage.message }}</strong></p>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsRuntime().
  runtime: {
    type: Object,
    required: true,
  },
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
  selectedAiRuntimeProfile,
  aiRuntimeJob,
  aiRuntimeBusy,
  aiRuntimeMessage,
  aiSetupCopied,
  recheckingRuntime,
  aiRuntimeProfileRows,
  aiRuntimeInstallProgress,
  aiSetupCommand,
  startAiRuntimeInstall,
  cancelAiRuntimeInstall,
  recheckAiRuntime,
  copyAiSetupCommand,
} = props.runtime

const {
  autoTagStatus,
  huggingFaceToken,
  savingToken,
  modelCatalog,
  modelStatusMessage,
  aiRuntimeMissing,
  effectiveTorch,
  effectiveOnnxReady,
  torchSummary,
  torchDeviceDetail,
  saveHuggingFaceToken,
  deleteHuggingFaceToken,
} = props.autoTag

const {
  downloadedModelCount,
  loadedModelCount,
  missingRuntimeModels,
  enabledModels,
  enabledModelNames,
  enabledModelsMissingDownloads,
} = props.models
</script>
<style scoped>
.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
  color: var(--text-primary);
}

.path-input-group {
  display: flex;
  gap: 0.5rem;
}

.path-input {
  flex: 1;
  font-family: 'Courier New', monospace;
  font-size: 0.85rem;
}

.help-text {
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.help-text code {
  background: var(--bg-secondary);
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.8rem;
}

.migration-status.error,
.cookies-status.error {
  background: var(--coral-soft);
  border-color: var(--coral);
  color: var(--text-primary);
}

.cookies-status {
  margin: 1rem 0;
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
}

.cookies-status.success {
  background: var(--success-soft);
  border-color: var(--success);
  color: var(--text-primary);
}

.form-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1.5rem;
}

.info-item label {
  display: block;
  font-weight: 500;
  margin-bottom: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.info-item code {
  display: block;
  font-family: 'Courier New', monospace;
  font-size: 0.8rem;
  color: var(--text-primary);
  word-break: break-all;
  background: var(--bg-primary);
  padding: 0.5rem;
  border-radius: 0.25rem;
}

.auto-status,
.job-panel {
  padding: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  margin-bottom: 1rem;
  color: var(--text-primary);
}

.pipeline-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.pipeline-models {
  color: var(--text-secondary);
  font-size: 0.9rem;
  text-align: right;
}

.pipeline-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.75rem;
}

.pipeline-grid div {
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.pipeline-grid span {
  display: block;
  color: var(--text-secondary);
  font-size: 0.78rem;
  margin-bottom: 0.25rem;
}

.pipeline-grid strong {
  font-size: 0.95rem;
}

.status-note {
  margin: 0.75rem 0 0;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.status-note.warning {
  color: var(--warning);
}

.download-summary {
  margin-top: 1rem;
  padding: 0.85rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.download-summary-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  color: var(--text-primary);
  margin-bottom: 0.6rem;
}

.download-summary p {
  margin: 0.4rem 0 0;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.config-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.9rem;
}

.config-panel-head h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.95rem;
}

.config-panel-head p {
  margin: 0;
  max-width: 560px;
  color: var(--text-secondary);
  font-size: 0.82rem;
  text-align: right;
}

.toggle-card input,
.model-toggle-row input {
  margin-top: 0.15rem;
}

.toggle-card strong,
.model-toggle-row strong {
  display: block;
  margin-bottom: 0.2rem;
  font-size: 0.9rem;
}

.toggle-card small,
.model-toggle-row small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.ai-setup-panel {
  padding: 1rem;
  margin-bottom: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--accent, var(--border));
  border-radius: 0.5rem;
}

.ai-setup-target {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0.75rem;
  margin-bottom: 0.9rem;
}

.radio-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 0.6rem;
  align-items: flex-start;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  cursor: pointer;
}

.radio-row input {
  margin-top: 0.15rem;
}

.radio-row strong {
  display: block;
  font-size: 0.9rem;
}

.radio-row small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.radio-row em {
  display: block;
  margin-top: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-style: normal;
}

.ai-profile-grid {
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.ai-setup-command {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.9rem;
}

.ai-setup-command code {
  flex: 1;
  padding: 0.6rem 0.75rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  font-family: monospace;
  font-size: 0.82rem;
  overflow-x: auto;
  white-space: nowrap;
}

.model-ok {
  color: var(--success);
  font-weight: 600;
}

.model-missing {
  color: var(--text-secondary);
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
  background: var(--accent);
  transition: width 0.3s ease;
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
}
</style>
