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
.section-description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-bottom: 1.5rem;
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

.update-panel {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--bg-secondary);
}

.update-summary {
  margin-top: 1rem;
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

.runtime-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}

.runtime-summary-grid > div {
  display: grid;
  gap: 0.25rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.runtime-summary-grid span {
  color: var(--text-secondary);
  font-size: 0.76rem;
  text-transform: uppercase;
}

.runtime-summary-grid strong {
  color: var(--text-primary);
}

.runtime-summary-grid small {
  color: var(--text-secondary);
  line-height: 1.35;
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

.toggle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
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

.numeric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}

.field-row {
  display: grid;
  gap: 0.35rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.field-row input,
.field-row select,
.field-row textarea {
  width: 100%;
}

.model-ok {
  color: var(--success);
  font-weight: 600;
}

.model-missing {
  color: var(--text-secondary);
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
