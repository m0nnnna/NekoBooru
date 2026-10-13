<template>
  <div class="settings-view">
    <div class="settings-header">
      <h1>Settings</h1>
      <div class="settings-header-actions">
        <span class="settings-header-count">{{ openSectionCount }} of {{ settingsSectionIds.length }} open</span>
        <button class="btn btn-secondary btn-small" @click="setAllSections(true)">Expand all</button>
        <button class="btn btn-secondary btn-small" @click="setAllSections(false)">Collapse all</button>
      </div>
    </div>

    <CollapsibleSection
      title="Data Storage"
      :open="isSectionOpen('data-storage')"
      @toggle="toggleSection('data-storage')"
    >
      <SettingsDataStorage :server="server" />
    </CollapsibleSection>

    <CollapsibleSection
      title="Search"
      :open="isSectionOpen('search')"
      @toggle="toggleSection('search')"
    >
      <p class="section-description">
        Configure how tag search behaves in the main navigation bar.
      </p>

      <label class="toggle-card">
        <input type="checkbox" v-model="searchPredictionEnabled" @change="saveSearchPredictionSetting" />
        <span>
          <strong>Auto-search while typing</strong>
          <small>
            When semantic search is off, partial tag searches use the top autocomplete match automatically.
            When semantic search is on, the typed phrase searches as-is and suggestions require a click or arrow+Enter.
          </small>
        </span>
      </label>
      <label class="toggle-card">
        <input type="checkbox" v-model="namePartAutocompleteEnabled" @change="saveNamePartAutocompleteSetting" />
        <span>
          <strong>Autocomplete character given names</strong>
          <small>
            Allows partial-name searches like konata to suggest tags such as izumi_konata.
          </small>
        </span>
      </label>
      <label class="toggle-card">
        <input type="checkbox" v-model="autoTagSettings.semanticSearchEnabled" @change="saveSemanticSearchSetting" />
        <span>
          <strong>Semantic search</strong>
          <small>
            Searches tags plus saved Qwen semantic analysis so phrases like music edit, protest, or pink bikini can find posts without running a model.
          </small>
        </span>
      </label>
      <BooruSearchAdminCard v-if="authStore.isAdmin" />
    </CollapsibleSection>

    <CollapsibleSection
      title="AI Model Defaults"
      :open="isSectionOpen('ai-model-defaults')"
      @toggle="toggleSection('ai-model-defaults')"
    >
      <SettingsAiDefaults :ai-models="aiModels" />
    </CollapsibleSection>

    <CollapsibleSection
      title="Browser Extension"
      :open="isSectionOpen('browser-extension')"
      @toggle="toggleSection('browser-extension')"
    >
      <SettingsExtensionDefaults :prefs="prefs" />
    </CollapsibleSection>

    <CollapsibleSection
      title="Server"
      :open="isSectionOpen('server')"
      @toggle="toggleSection('server')"
    >
      <SettingsServer :server="server" />
    </CollapsibleSection>

    <CollapsibleSection
      title="Video Downloads (yt-dlp)"
      :open="isSectionOpen('video-downloads-yt-dlp')"
      @toggle="toggleSection('video-downloads-yt-dlp')"
    >
      <SettingsVideoDownloads :ytdlp="ytdlp" :server="server" />
    </CollapsibleSection>

    <CollapsibleSection
      title="Directory Information"
      :open="isSectionOpen('directory-information')"
      @toggle="toggleSection('directory-information')"
    >
      <div class="info-grid">
        <div class="info-item">
          <label>Database</label>
          <code>{{ currentSettings.database_path || 'N/A' }}</code>
        </div>
        <div class="info-item">
          <label>Posts</label>
          <code>{{ currentSettings.posts_dir || 'N/A' }}</code>
        </div>
        <div class="info-item">
          <label>Thumbnails</label>
          <code>{{ currentSettings.thumbs_dir || 'N/A' }}</code>
        </div>
        <div class="info-item">
          <label>Uploads</label>
          <code>{{ currentSettings.uploads_dir || 'N/A' }}</code>
        </div>
      </div>
    </CollapsibleSection>

    <CollapsibleSection
      title="Runtime & Packaging"
      :open="isSectionOpen('runtime-packaging')"
      @toggle="toggleSection('runtime-packaging')"
    >
      <SettingsRuntimeStatus :runtime="runtime" />
    </CollapsibleSection>

    <CollapsibleSection
      title="App Updates"
      :open="isSectionOpen('app-updates')"
      @toggle="toggleSection('app-updates')"
    >
      <SettingsAppUpdates :runtime="runtime" />
    </CollapsibleSection>

    <CollapsibleSection
      title="Auto Tagging"
      :open="isSectionOpen('auto-tagging')"
      @toggle="toggleSection('auto-tagging')"
    >
      <p class="section-description">
        Optional local AI tagging for imports, individual posts, and your existing library.
        It is disabled by default and not bundled with the app — turn it on here to set it up.
      </p>

      <label class="toggle-card ai-master-toggle">
        <input type="checkbox" v-model="autoTagSettings.enabled" @change="saveAutoTagSettings" />
        <span>
          <strong>Enable AI features</strong>
          <small>Reveals model setup, the per-post AI Tag button, and auto-tagging on uploads.</small>
        </span>
      </label>

      <div v-if="autoTagSettings.enabled" class="ai-config-body">
      <SettingsAiRuntime :runtime="runtime" :auto-tag="autoTag" :models="models" />

      <SettingsModelRegistry :auto-tag="autoTag" :models="models" />

      <SettingsAiPipeline :auto-tag="autoTag" />

      <SettingsBulkJob :bulk="bulk" :auto-tag="autoTag" />
      </div>
    </CollapsibleSection>

    <CollapsibleSection
      title="Restart"
      :open="isSectionOpen('restart')"
      @toggle="toggleSection('restart')"
    >
      <p class="section-description">
        Restart the packaged NekoBooru app after changing runtime, packaging, or port settings.
      </p>

      <div class="form-actions">
        <button
          class="btn"
          @click="restartNekoBooru"
          :disabled="restartBusy || !runtimeStatus.restart?.available"
          :title="runtimeStatus.restart?.message || 'Restart NekoBooru'"
        >
          {{ restartBusy ? 'Restarting...' : 'Restart NekoBooru' }}
        </button>
      </div>
      <p
        v-if="restartMessage.show || runtimeStatus.restart"
        class="status-note"
        :class="restartMessage.show ? (restartMessage.success ? 'model-ok' : 'model-missing') : ''"
      >
        {{ restartMessage.show ? restartMessage.message : runtimeStatus.restart?.message }}
      </p>
    </CollapsibleSection>

    <CollapsibleSection
      title="Account &amp; Sharing"
      :open="isSectionOpen('account-sharing')"
      @toggle="toggleSection('account-sharing')"
    >
      <SettingsAccountSharing :account="account" />
    </CollapsibleSection>

    <!-- Rendered twice, exactly as before the split. -->
    <SettingsPreviewModal :bulk="bulk" />

    <SettingsPreviewModal :bulk="bulk" />
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import api from '../api/client'
import CollapsibleSection from '../components/CollapsibleSection.vue'
import BooruSearchAdminCard from '../components/BooruSearchAdminCard.vue'
import SettingsAccountSharing from '../components/settings/SettingsAccountSharing.vue'
import SettingsAiDefaults from '../components/settings/SettingsAiDefaults.vue'
import SettingsAiPipeline from '../components/settings/SettingsAiPipeline.vue'
import SettingsAiRuntime from '../components/settings/SettingsAiRuntime.vue'
import SettingsAppUpdates from '../components/settings/SettingsAppUpdates.vue'
import SettingsBulkJob from '../components/settings/SettingsBulkJob.vue'
import SettingsDataStorage from '../components/settings/SettingsDataStorage.vue'
import SettingsExtensionDefaults from '../components/settings/SettingsExtensionDefaults.vue'
import SettingsModelRegistry from '../components/settings/SettingsModelRegistry.vue'
import SettingsPreviewModal from '../components/settings/SettingsPreviewModal.vue'
import SettingsRuntimeStatus from '../components/settings/SettingsRuntimeStatus.vue'
import SettingsServer from '../components/settings/SettingsServer.vue'
import SettingsVideoDownloads from '../components/settings/SettingsVideoDownloads.vue'
import { useSettingsAccount } from '../composables/useSettingsAccount'
import { useSettingsAiModels } from '../composables/useSettingsAiModels'
import { useSettingsAutoTag } from '../composables/useSettingsAutoTag'
import { useSettingsBulkJob } from '../composables/useSettingsBulkJob'
import { useSettingsModels } from '../composables/useSettingsModels'
import { useSettingsPreferences } from '../composables/useSettingsPreferences'
import { useSettingsRuntime } from '../composables/useSettingsRuntime'
import { useSettingsServer } from '../composables/useSettingsServer'
import { useSettingsYtdlp } from '../composables/useSettingsYtdlp'
import { useAuthStore } from '../stores/auth'

const authStore = useAuthStore()

const prefs = useSettingsPreferences()
const server = useSettingsServer()
const ytdlp = useSettingsYtdlp({ server })
const autoTag = useSettingsAutoTag()
const runtime = useSettingsRuntime({ autoTag })
const models = useSettingsModels({ autoTag, runtime })
const aiModels = useSettingsAiModels({ autoTag, models })
const bulk = useSettingsBulkJob({ autoTag, models })
const account = useSettingsAccount()

const {
  settingsSectionIds,
  openSectionCount,
  isSectionOpen,
  toggleSection,
  setAllSections,
  loadSectionState,
  searchPredictionEnabled,
  namePartAutocompleteEnabled,
  loadSearchPredictionSetting,
  saveSearchPredictionSetting,
  saveNamePartAutocompleteSetting,
  loadExtensionSettings,
} = prefs
const { currentSettings, loadSettings } = server
const { refreshYtdlpStatus } = ytdlp
const {
  autoTagSettings,
  autoTagStatus,
  defaultSemanticPrompt,
  modelCatalog,
  modelDownloadJob,
  saveAutoTagSettings,
} = autoTag
const {
  runtimeStatus,
  restartBusy,
  restartMessage,
  loadRuntimeStatus,
  restartNekoBooru,
  loadUpdateStatus,
} = runtime
const { modelDownloadRunning, startModelDownloadPolling } = models
const { loadAiModelDefaults, hydrateAiModelDefaults } = aiModels
const { autoTagJob, autoTagJobRunning, startAutoTagPolling } = bulk
const { loadAccountSharing } = account

onMounted(async () => {
  loadSectionState()
  loadSearchPredictionSetting()
  await Promise.all([loadSettings(), loadExtensionSettings(), loadAutoTags(), refreshYtdlpStatus(), loadRuntimeStatus(), loadUpdateStatus(true)])
  await loadAiModelDefaults()
  await loadAccountSharing()
})

async function saveSemanticSearchSetting() {
  try {
    if (!Object.keys(autoTagSettings.value || {}).length) {
      await loadAutoTags()
    }
    autoTagSettings.value.semanticSearchEnabled = autoTagSettings.value.semanticSearchEnabled === true
    await saveAutoTagSettings()
    window.dispatchEvent(new CustomEvent('nekobooru:semantic-search-setting', {
      detail: { enabled: autoTagSettings.value.semanticSearchEnabled === true },
    }))
  } catch (e) {
    alert('Failed to save semantic search setting: ' + e.message)
  }
}

async function loadAutoTags() {
  try {
    const [settingsResult, statusResult, currentJob, modelsResult] = await Promise.all([
      api.getAutoTagSettings(),
      api.getAutoTagStatus(),
      api.getCurrentAutoTagJob(),
      api.getAutoTagModels(),
    ])
    autoTagSettings.value = {
      ...settingsResult,
      wdEnabled: settingsResult.wdEnabled !== false,
      torchDevice: settingsResult.torchDevice || 'auto',
      semanticPrompt: settingsResult.semanticPrompt || defaultSemanticPrompt,
      semanticPromptEnabled: settingsResult.semanticPromptEnabled !== false,
      semanticSearchEnabled: settingsResult.semanticSearchEnabled === true,
      saveSemanticAnalysis: settingsResult.saveSemanticAnalysis === true,
      semanticModelId: settingsResult.semanticModelId || 'qwen',
      qwenVideoUseFps: settingsResult.qwenVideoUseFps === true,
      qwenVideoMaxFrames: Number(settingsResult.qwenVideoMaxFrames || 20),
    }
    autoTagStatus.value = statusResult
    autoTagJob.value = currentJob
    modelCatalog.value = modelsResult.models || []
    modelDownloadJob.value = modelsResult.downloadJob
    hydrateAiModelDefaults()
    if (autoTagJobRunning.value) startAutoTagPolling()
    if (modelDownloadRunning.value) startModelDownloadPolling()
  } catch (e) {
    console.error('Failed to load auto tag settings:', e)
  }
}
</script>

<style scoped>
.settings-view {
  max-width: 900px;
  margin: 0 auto;
}

/* Card chrome and the h2 now live in CollapsibleSection.vue. */
.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.settings-header h1 {
  margin: 0;
}

.settings-header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.settings-header-count {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-right: 0.25rem;
}

.section-description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-bottom: 1.5rem;
}

.form-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1.5rem;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
}

.info-item {
  padding: 0.75rem;
  background: var(--bg-secondary);
  border-radius: 0.5rem;
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

.status-note {
  margin: 0.75rem 0 0;
  color: var(--text-secondary);
  font-size: 0.85rem;
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

.ai-master-toggle {
  max-width: 520px;
  margin-bottom: 1rem;
}

.ai-config-body {
  display: contents;
}

.btn-small {
  padding: 0.4rem 0.65rem;
  font-size: 0.8rem;
}

.model-ok {
  color: var(--success);
  font-weight: 600;
}

.model-missing {
  color: var(--text-secondary);
}
</style>
