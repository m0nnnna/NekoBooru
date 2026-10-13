<template>
  <p class="section-description">
    Configure cookies for downloading age-restricted or login-required videos from platforms like X/Twitter.
    Export cookies from your browser using an extension like "Get cookies.txt LOCALLY" and upload the file here.
  </p>

  <div class="form-group">
    <label>Cookies File</label>
    <div class="cookies-upload-area">
      <div v-if="currentSettings.ytdlp_cookies_configured" class="cookies-configured">
        <span class="cookies-status-icon success">&#10003;</span>
        <span>Cookies file uploaded</span>
      </div>
      <div v-else class="cookies-not-configured">
        <span class="cookies-status-icon">&#10007;</span>
        <span>No cookies file uploaded</span>
      </div>
    </div>
    <input
      ref="cookiesFileInput"
      type="file"
      accept=".txt"
      @change="handleCookiesFileSelect"
      style="display: none"
    />
  </div>

  <div v-if="cookiesStatus.show" class="cookies-status" :class="cookiesStatus.success ? 'success' : 'error'">
    <p><strong>{{ cookiesStatus.success ? '&#10003;' : '&#10007;' }} {{ cookiesStatus.message }}</strong></p>
  </div>

  <div class="form-actions">
    <button
      class="btn"
      @click="triggerCookiesUpload"
      :disabled="savingCookies"
    >
      {{ savingCookies ? 'Uploading...' : 'Upload Cookies File' }}
    </button>
    <button
      class="btn btn-secondary"
      @click="deleteCookiesFile"
      :disabled="savingCookies || !currentSettings.ytdlp_cookies_configured"
    >
      Delete
    </button>
  </div>

  <div class="ytdlp-panel">
    <div class="config-panel-head">
      <h3>yt-dlp Video Downloader</h3>
      <p>Used for X/Twitter, YouTube, Reddit, and other page-based video URLs. Direct media files do not need this.</p>
    </div>
    <div class="ytdlp-status-grid">
      <div>
        <span>Runtime</span>
        <strong :class="ytdlpStatus.installed ? 'model-ok' : 'model-missing'">
          {{ ytdlpStatus.installed ? 'Ready' : 'Not installed' }}
        </strong>
        <small>{{ ytdlpStatus.version || 'Install yt-dlp in the backend venv' }}</small>
      </div>
      <div>
        <span>Last update</span>
        <strong :class="ytdlpJobClass">{{ ytdlpJobLabel }}</strong>
        <small>{{ ytdlpJobDetail }}</small>
      </div>
    </div>
    <p class="help-text">
      Python: <code :title="ytdlpStatus.python || ''">{{ ytdlpStatus.pythonDisplay || ytdlpStatus.python || 'unknown' }}</code>
    </p>
    <p class="help-text">
      Import path: <code :title="ytdlpStatus.path || ''">{{ ytdlpStatus.pathDisplay || ytdlpStatus.path || 'not found' }}</code>
    </p>

    <div class="ytdlp-controls">
      <label class="field-row">
        <span>Automatic update on backend start</span>
        <select v-model="ytdlpSettings.updatePolicy">
          <option value="manual">Off - update manually</option>
          <option value="startup_latest">Always install latest</option>
          <option value="startup_pinned">Always install pinned version</option>
        </select>
      </label>
      <label class="field-row">
        <span>Pinned version for rollback</span>
        <input v-model="ytdlpSettings.pinnedVersion" type="text" placeholder="Example: 2026.03.17" />
      </label>
    </div>
    <p class="help-text">
      Most failures are site/login/cookie issues, not an installed-runtime issue. Use
      <a href="https://github.com/yt-dlp/yt-dlp" target="_blank" rel="noreferrer">yt-dlp releases</a>
      to pick a known-good pinned version when latest breaks.
    </p>

    <div v-if="ytdlpMessage.show" class="cookies-status" :class="ytdlpMessage.success ? 'success' : 'error'">
      <p><strong>{{ ytdlpMessage.message }}</strong></p>
    </div>

    <div v-if="ytdlpStatus.job?.output" class="ytdlp-output">
      <details>
        <summary>Last pip output</summary>
        <pre>{{ ytdlpStatus.job.output }}</pre>
      </details>
    </div>

    <div class="form-actions">
      <button class="btn" @click="saveYtdlpSettings" :disabled="ytdlpBusy">
        Save yt-dlp Settings
      </button>
      <button class="btn btn-secondary" @click="refreshYtdlpStatus" :disabled="ytdlpBusy">
        Refresh
      </button>
      <button class="btn btn-secondary" @click="startYtdlpUpdate('latest')" :disabled="ytdlpBusy">
        Install Latest
      </button>
      <button
        class="btn btn-secondary"
        @click="startYtdlpUpdate(ytdlpSettings.pinnedVersion)"
        :disabled="ytdlpBusy || !ytdlpSettings.pinnedVersion.trim()"
      >
        Install Pinned
      </button>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsYtdlp().
  ytdlp: {
    type: Object,
    required: true,
  },
  // The object returned by useSettingsServer().
  server: {
    type: Object,
    required: true,
  },
})

const {
  cookiesFileInput,
  savingCookies,
  cookiesStatus,
  ytdlpStatus,
  ytdlpSettings,
  ytdlpBusy,
  ytdlpMessage,
  ytdlpJobLabel,
  ytdlpJobDetail,
  ytdlpJobClass,
  triggerCookiesUpload,
  handleCookiesFileSelect,
  deleteCookiesFile,
  refreshYtdlpStatus,
  saveYtdlpSettings,
  startYtdlpUpdate,
} = props.ytdlp

const { currentSettings } = props.server
</script>
<style scoped>
.help-text code {
  background: var(--bg-secondary);
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.8rem;
}

.cookies-upload-area {
  padding: 1rem;
  background: var(--bg-secondary);
  border-radius: 0.5rem;
  margin-bottom: 0.5rem;
}

.cookies-configured,
.cookies-not-configured {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cookies-status-icon {
  font-weight: bold;
  font-size: 1.1rem;
}

.cookies-status-icon.success {
  color: var(--success);
}

.ytdlp-panel {
  margin-top: 1.25rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--bg-secondary);
}

.ytdlp-status-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  margin: 1rem 0;
}

.ytdlp-status-grid div {
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.ytdlp-status-grid span {
  display: block;
  margin-bottom: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.78rem;
  text-transform: uppercase;
}

.ytdlp-status-grid strong {
  color: var(--text-primary);
}

.ytdlp-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}

.ytdlp-output pre {
  max-height: 220px;
  overflow: auto;
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
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

  .ytdlp-status-grid,
  .ytdlp-controls {
    grid-template-columns: 1fr;
  }
}
</style>
