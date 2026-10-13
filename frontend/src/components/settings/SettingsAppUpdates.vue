<template>
  <p class="section-description">
    Check GitHub Releases for installer builds. Upstream releases are the default; point this at your fork when testing your own builds.
  </p>

  <div class="update-panel">
    <div class="config-panel-head">
      <h3>Release Source</h3>
      <p>{{ updateStatus.settings?.releasesPageUrl || 'GitHub Releases' }}</p>
    </div>

    <div class="numeric-grid">
      <label class="field-row">
        <span>GitHub owner</span>
        <input v-model="updateSettings.owner" type="text" placeholder="m0nnnna" />
      </label>
      <label class="field-row">
        <span>Repository</span>
        <input v-model="updateSettings.repo" type="text" placeholder="NekoBooru" />
      </label>
      <label class="field-row">
        <span>Channel</span>
        <select v-model="updateSettings.channel">
          <option value="stable">Stable releases</option>
          <option value="prerelease">Prereleases</option>
          <option value="off">Off</option>
        </select>
      </label>
    </div>

    <div class="toggle-grid">
      <label class="toggle-card">
        <input type="checkbox" v-model="updateSettings.autoCheck" />
        <span>
          <strong>Auto-check for updates</strong>
          <small>Checks at Settings load at most twice per day. It does not auto-install anything.</small>
        </span>
      </label>
    </div>

    <div class="runtime-summary-grid update-summary">
      <div>
        <span>Current</span>
        <strong>{{ updateStatus.currentVersion || runtimeStatus.app?.version || 'unknown' }}</strong>
        <small>{{ runtimeStatus.app?.packaged ? 'installed package' : 'source checkout' }}</small>
      </div>
      <div>
        <span>Latest</span>
        <strong :class="updateStatus.lastCheck?.available ? 'model-ok' : ''">
          {{ updateStatus.lastCheck?.latestVersion || 'Not checked' }}
        </strong>
        <small>{{ updateStatus.lastCheck?.message || 'Use Check now to query releases.' }}</small>
      </div>
      <div>
        <span>Installer asset</span>
        <strong :class="updateStatus.lastCheck?.assets?.windowsInstaller ? 'model-ok' : 'model-missing'">
          {{ updateStatus.lastCheck?.assets?.windowsInstaller?.name || 'Not found yet' }}
        </strong>
        <small>{{ formatBytes(updateStatus.lastCheck?.assets?.windowsInstaller?.size) }}</small>
      </div>
    </div>

    <p v-if="updateMessage.show" class="cookies-status" :class="updateMessage.success ? 'success' : 'error'">
      <strong>{{ updateMessage.message }}</strong>
    </p>

    <div class="form-actions">
      <button class="btn" @click="saveUpdateSettings" :disabled="updateBusy">
        Save Update Settings
      </button>
      <button class="btn btn-secondary" @click="checkForUpdates" :disabled="updateBusy || updateSettings.channel === 'off'">
        {{ updateBusy ? 'Checking...' : 'Check now' }}
      </button>
      <a
        v-if="updateStatus.lastCheck?.htmlUrl"
        class="btn btn-secondary"
        :href="updateStatus.lastCheck.htmlUrl"
        target="_blank"
        rel="noreferrer"
      >
        Release notes
      </a>
    </div>
  </div>
</template>

<script setup>
import { formatBytes } from '../../composables/useSettingsModels'

const props = defineProps({
  // The object returned by useSettingsRuntime().
  runtime: {
    type: Object,
    required: true,
  },
})

const {
  runtimeStatus,
  updateStatus,
  updateSettings,
  updateBusy,
  updateMessage,
  saveUpdateSettings,
  checkForUpdates,
} = props.runtime
</script>
<style scoped>
.update-panel {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--bg-secondary);
}

.update-summary {
  margin-top: 1rem;
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
