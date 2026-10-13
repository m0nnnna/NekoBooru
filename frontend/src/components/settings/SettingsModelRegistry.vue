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
.gelbooru-api-settings {
  margin-top: 1rem;
}

.gelbooru-credentials {
  flex-wrap: wrap;
}

.gelbooru-user-id {
  max-width: 12rem;
}

.help-text code {
  background: var(--bg-secondary);
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.8rem;
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

/* Not a model row: it enriches whatever the models above produced. */
.booru-lookup-toggle {
  margin-top: 0.85rem;
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
