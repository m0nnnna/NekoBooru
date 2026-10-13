<template>
  <div class="model-download-panel">
    <div class="config-panel-head">
      <h3>Model Registry</h3>
      <p>Download weights, review resource needs, and choose which models run by default.</p>
    </div>

    <div class="form-actions model-download-actions">
      <button
        class="btn"
        :class="{ 'btn-danger': modelDownloadRunning }"
        @click="modelDownloadRunning ? cancelModelDownload() : downloadAllAutoTagModels()"
        :disabled="modelDownloadCancelling"
      >
        {{ modelDownloadRunning ? (modelDownloadCancelling ? 'Cancelling...' : 'Cancel Download') : 'Download All Models' }}
      </button>
      <button class="btn btn-secondary" @click="refreshAutoTagStatus">
        Refresh Status
      </button>
    </div>

    <div v-if="modelDownloadJob" class="download-summary">
      <div class="download-summary-head">
        <strong>{{ downloadJobTitle }}</strong>
        <span>{{ downloadJobCounts }}</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: downloadJobProgress + '%' }"></div>
      </div>
      <p>{{ downloadJobDetail }}</p>
    </div>

    <SettingsSemanticBackends :auto-tag="autoTag" :models="models" />

    <div class="model-list compact-model-list">
      <div v-for="model in nonSemanticModels" :key="model.id" class="model-row compact-model-row">
        <div class="model-head">
          <div class="model-title">
            <strong>{{ model.name }}</strong>
            <button
              type="button"
              class="info-icon model-info-icon"
              :data-tooltip="modelInfoTitle(model)"
              :aria-label="modelInfoTitle(model)"
            >i</button>
            <span class="model-badge" :class="{ planned: model.status !== 'tagging_ready' }">
              {{ modelStatusLabel(model.status) }}
            </span>
          </div>
          <span :class="model.downloaded ? 'model-ok' : 'model-missing'">
            {{ model.downloaded ? 'Downloaded' : 'Not downloaded' }}
          </span>
        </div>
        <div class="model-meta">
          <code>{{ model.repoId }}</code>
          <span>{{ model.purpose }}</span>
          <div class="model-facts">
            <span><strong>Size</strong>{{ model.downloadSize || 'Unknown' }}</span>
            <span><strong>VRAM</strong>{{ model.vramRequirement || 'Unknown' }}</span>
            <span :class="model.runtimeAvailable ? 'model-ok' : 'model-missing'">
              <strong>Runtime</strong>{{ model.runtimeAvailable ? 'Ready' : 'Missing' }}
            </span>
            <span :class="model.loaded ? 'model-ok' : 'model-missing'">
              <strong>Memory</strong>{{ model.loaded ? 'Loaded' : 'Not loaded' }}
            </span>
          </div>
          <label v-if="modelPipelineConfigurable(model)" class="pipeline-toggle">
            <input type="checkbox" v-model="autoTagSettings[modelSettingKey(model.id)]" />
            <span>
              <strong>{{ modelPipelineLabel(model.id) }}</strong>
              <small>{{ modelPipelineDescription(model.id) }}</small>
            </span>
          </label>
        </div>
        <div v-if="modelDownloadState(model.id)" class="model-progress">
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
        <div class="model-actions">
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

    <label class="toggle-card booru-lookup-toggle">
      <input type="checkbox" v-model="autoTagSettings.booruSuggestEnabled" @change="saveAutoTagSettings" />
      <span>
        <strong>Booru tag suggestions</strong>
        <small>
          While typing a tag, also suggest tags this library does not have yet from Danbooru and Gelbooru,
          with the category they use there - so a character arrives filed as a character. Sends the partial
          tag you are typing to those sites.
        </small>
      </span>
    </label>

    <div class="form-group gelbooru-api-settings">
      <label>Gelbooru API credentials</label>
      <div class="path-input-group gelbooru-credentials">
        <input
          v-model="gelbooruUserId"
          class="path-input gelbooru-user-id"
          type="text"
          inputmode="numeric"
          placeholder="Numeric user ID"
          autocomplete="off"
        />
        <input
          v-model="gelbooruApiKey"
          class="path-input"
          type="password"
          placeholder="API key"
          autocomplete="off"
        />
        <button
          class="btn btn-secondary"
          @click="saveGelbooruCredentials"
          :disabled="savingGelbooruCredentials || !gelbooruUserId.trim() || !gelbooruApiKey.trim()"
        >
          {{ savingGelbooruCredentials ? 'Saving...' : 'Save credentials' }}
        </button>
        <button
          class="btn btn-secondary"
          @click="deleteGelbooruCredentials"
          :disabled="savingGelbooruCredentials || !autoTagStatus.gelbooruCredentialsConfigured"
        >
          Forget
        </button>
      </div>
      <p class="help-text">
        {{ autoTagStatus.gelbooruCredentialsConfigured ? 'Configured. ' : '' }}
        Copy both values from Gelbooru’s Account Options → API Access Credentials.
        Stored locally and attached only to Gelbooru requests (tag suggestions and booru search); the API key is never returned to this page.
      </p>
      <div
        v-if="gelbooruCredentialsMessage.show"
        class="cookies-status compact-status"
        :class="gelbooruCredentialsMessage.success ? 'success' : 'error'"
      >
        {{ gelbooruCredentialsMessage.message }}
      </div>
    </div>

    <label class="toggle-card booru-lookup-toggle">
      <input type="checkbox" v-model="autoTagSettings.booruLookupEnabled" @change="saveAutoTagSettings" />
      <span>
        <strong>Booru series lookup</strong>
        <small>
          After tagging, look each recognised character up on Danbooru (Safebooru as a fallback) and add its series.
          Purely additive - it never removes or replaces what the models found. Makes a network call per new character;
          results are cached until the server restarts.
        </small>
      </span>
    </label>
  </div>
</template>

<script setup>
import SettingsSemanticBackends from './SettingsSemanticBackends.vue'
import {
  modelInfoTitle,
  modelPipelineConfigurable,
  modelPipelineDescription,
  modelPipelineLabel,
  modelSettingKey,
} from '../../composables/useSettingsAiModels'

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
  autoTagStatus,
  gelbooruUserId,
  gelbooruApiKey,
  savingGelbooruCredentials,
  gelbooruCredentialsMessage,
  modelDownloadJob,
  saveAutoTagSettings,
  refreshAutoTagStatus,
  saveGelbooruCredentials,
  deleteGelbooruCredentials,
} = props.autoTag

const {
  modelMemoryBusy,
  modelDeleteBusy,
  modelDownloadRunning,
  modelDownloadCancelling,
  downloadJobProgress,
  downloadJobTitle,
  downloadJobCounts,
  downloadJobDetail,
  nonSemanticModels,
  downloadAutoTagModelById,
  downloadAllAutoTagModels,
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
  modelStatusLabel,
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

.gelbooru-api-settings {
  margin-top: 1rem;
}

.gelbooru-credentials {
  flex-wrap: wrap;
}

.gelbooru-user-id {
  max-width: 12rem;
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

/* Stats Section */
.stats-loading,
.stats-error {
  padding: 1rem;
  text-align: center;
  color: var(--text-secondary);
}

.stats-error {
  color: var(--coral);
}

.model-list {
  display: grid;
  gap: 0.75rem;
  margin: 1rem 0;
}

.model-download-panel {
  padding: 1rem;
  margin-top: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.model-download-actions {
  justify-content: flex-start;
  margin-top: 0;
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

.toggle-card,
.model-toggle-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.toggle-card input,
.model-toggle-row input {
  margin-top: 0.15rem;
}

/* Not a model row: it enriches whatever the models above produced. */
.booru-lookup-toggle {
  margin-top: 0.85rem;
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

.info-icon {
  position: relative;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  cursor: help;
  font-size: 0.72rem;
  line-height: 16px;
}

.info-icon:hover {
  color: var(--text-primary);
  border-color: var(--accent);
}

.info-icon::after {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 20;
  display: block;
  width: max-content;
  max-width: min(360px, 70vw);
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
  content: attr(data-tooltip);
  font-size: 0.78rem;
  font-weight: 500;
  line-height: 1.4;
  text-align: left;
  text-transform: none;
  letter-spacing: 0;
  white-space: pre-line;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.info-icon::before {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 4px);
  z-index: 21;
  width: 10px;
  height: 10px;
  background: #111827;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  content: '';
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px) rotate(45deg);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.info-icon:hover::after,
.info-icon:focus-visible::after,
.info-icon:hover::before,
.info-icon:focus-visible::before {
  opacity: 1;
  transform: translate(-50%, 0);
}

.info-icon:hover::before,
.info-icon:focus-visible::before {
  transform: translate(-50%, 0) rotate(45deg);
}

.model-row {
  padding: 1rem;
  background: linear-gradient(180deg, var(--bg-secondary), var(--bg-primary));
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.compact-model-list {
  margin-bottom: 0;
}

.compact-model-row {
  padding: 0.8rem;
}

.model-head,
.model-meta,
.model-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.model-head {
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.model-title {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

.model-info-icon {
  flex: 0 0 auto;
}

.model-meta {
  align-items: flex-start;
  flex-direction: column;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.model-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 0.5rem;
  width: 100%;
  margin-top: 0.25rem;
}

.model-facts span {
  padding: 0.55rem 0.65rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.45rem;
}

.model-facts.compact span,
.compact-model-row .model-facts span {
  padding: 0.45rem 0.55rem;
}

.model-facts strong {
  display: block;
  margin-bottom: 0.2rem;
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pipeline-toggle {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 0.75rem;
  align-items: flex-start;
  width: 100%;
  margin-top: 0.35rem;
  padding: 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  color: var(--text-primary);
}

.pipeline-toggle input {
  margin-top: 0.15rem;
}

.pipeline-toggle strong {
  display: block;
  margin-bottom: 0.15rem;
  font-size: 0.86rem;
}

.pipeline-toggle small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.35;
}

.compact-status {
  margin: 0.2rem 0 0;
  padding: 0.55rem 0.7rem;
}

.model-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.15rem 0.4rem;
  border-radius: 0.35rem;
  background: var(--success-soft);
  color: var(--text-primary);
  font-size: 0.75rem;
}

.model-badge.planned {
  background: var(--warning);
}

.model-ok {
  color: var(--success);
  font-weight: 600;
}

.model-missing {
  color: var(--text-secondary);
}

.model-progress {
  margin-top: 0.75rem;
}

.model-progress p {
  margin: 0.35rem 0 0;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.model-actions {
  margin-top: 0.75rem;
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
