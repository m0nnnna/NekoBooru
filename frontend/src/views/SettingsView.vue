<template>
  <div class="settings-view">
    <h1>Settings</h1>

    <div class="settings-section">
      <h2>Data Storage</h2>
      <p class="section-description">
        Configure where NekoBooru stores your data (posts, thumbnails, database).
        Changing this location will migrate your existing data.
      </p>

      <div class="form-group">
        <label>Data Directory</label>
        <div class="path-input-group">
          <input
            v-model="dataDir"
            type="text"
            placeholder="Enter data directory path"
            class="path-input"
          />
          <button class="btn btn-secondary" @click="browseDirectory" v-if="!isWindows">
            Browse
          </button>
        </div>
        <p class="help-text">
          Current: <code>{{ currentSettings.data_dir || 'Loading...' }}</code>
        </p>
      </div>

      <div v-if="migrationPrompt.show" class="migration-prompt">
        <div class="alert alert-warning">
          <strong>⚠️ Data Migration Required</strong>
          <p>
            Data exists at the old location. Would you like to migrate it to the new location?
          </p>
          <div class="migration-info">
            <p><strong>From:</strong> <code>{{ migrationPrompt.old_path }}</code></p>
            <p><strong>To:</strong> <code>{{ migrationPrompt.new_path }}</code></p>
          </div>
          <div class="migration-actions">
            <button class="btn" @click="performMigration">Yes, Migrate Data</button>
            <button class="btn btn-secondary" @click="cancelMigration">Cancel</button>
          </div>
        </div>
      </div>

      <div v-if="migrationStatus.show" class="migration-status" :class="migrationStatus.success ? 'success' : 'error'">
        <p><strong>{{ migrationStatus.success ? '✓' : '✗' }} {{ migrationStatus.message }}</strong></p>
        <div v-if="migrationStatus.details" class="migration-details">
          <p v-if="migrationStatus.files_copied !== undefined">
            Files copied: {{ migrationStatus.files_copied }}
          </p>
          <p v-if="migrationStatus.directories_copied !== undefined">
            Directories copied: {{ migrationStatus.directories_copied }}
          </p>
        </div>
      </div>

      <div class="form-actions">
        <button
          class="btn"
          @click="saveSettings"
          :disabled="!dataDir.trim() || saving"
        >
          {{ saving ? 'Saving...' : 'Save Settings' }}
        </button>
        <button class="btn btn-secondary" @click="resetForm">Reset</button>
      </div>
    </div>

    <div class="settings-section">
      <h2>Search</h2>
      <p class="section-description">
        Configure how tag search behaves in the main navigation bar.
      </p>

      <label class="toggle-card">
        <input type="checkbox" v-model="searchPredictionEnabled" @change="saveSearchPredictionSetting" />
        <span>
          <strong>Auto-search top tag prediction while typing</strong>
          <small>
            When enabled, partial tag searches use the first autocomplete match automatically while
            keeping your typed text and suggestions visible. Exact tags and filters like rating:safe
            still search as typed.
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
    </div>

    <div class="settings-section">
      <h2>Server</h2>
      <p class="section-description">
        Configure the local address NekoBooru binds to. Host and port changes take effect after restart.
      </p>

      <div class="numeric-grid">
        <label class="field-row">
          <span class="label-with-help">
            Host
            <button type="button" class="info-icon" :data-tooltip="serverHelp.host" :aria-label="serverHelp.host">?</button>
          </span>
          <input v-model="serverSettings.host" type="text" placeholder="127.0.0.1" />
        </label>
        <label class="field-row">
          <span class="label-with-help">
            Port
            <button type="button" class="info-icon" :data-tooltip="serverHelp.port" :aria-label="serverHelp.port">?</button>
          </span>
          <input v-model.number="serverSettings.port" type="number" min="1" max="65535" />
        </label>
        <label class="field-row">
          <span class="label-with-help">
            Dev frontend/CORS port
            <button type="button" class="info-icon" :data-tooltip="serverHelp.frontendPort" :aria-label="serverHelp.frontendPort">?</button>
          </span>
          <input v-model.number="serverSettings.frontend_port" type="number" min="1" max="65535" />
        </label>
      </div>

      <label class="field-row cors-field">
        <span class="label-with-help">
          Allowed browser origins
          <button type="button" class="info-icon" :data-tooltip="serverHelp.cors" :aria-label="serverHelp.cors">?</button>
        </span>
        <textarea v-model="serverSettings.cors_origins" rows="3" spellcheck="false"></textarea>
      </label>

      <p v-if="serverStatus.show" class="cookies-status" :class="serverStatus.success ? 'success' : 'error'">
        <strong>{{ serverStatus.message }}</strong>
      </p>

      <div class="form-actions">
        <button class="btn" @click="saveServerSettings" :disabled="savingServer">
          {{ savingServer ? 'Saving...' : 'Save Server Settings' }}
        </button>
        <span class="status-note">
          Packaged URL: http://{{ currentSettings.host || '127.0.0.1' }}:{{ currentSettings.port || 8772 }} ·
          Dev/CORS port: http://127.0.0.1:{{ currentSettings.frontend_port || 5173 }}
        </span>
      </div>
    </div>

    <div class="settings-section">
      <h2>Video Downloads (yt-dlp)</h2>
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
    </div>

    <div class="settings-section">
      <h2>Directory Information</h2>
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
    </div>

    <div class="settings-section">
      <h2>Runtime & Packaging</h2>
      <p class="section-description">
        Installer-facing diagnostics for packaged paths, native host registration, tools, and optional AI runtime.
      </p>

      <div class="runtime-summary-grid">
        <div>
          <span>App mode</span>
          <strong>{{ runtimeStatus.app?.packaged ? 'Packaged' : 'Source checkout' }}</strong>
          <small>{{ runtimeStatus.app?.version || 'unknown version' }}</small>
        </div>
        <div>
          <span>AI runtime</span>
          <strong :class="runtimeStatus.ai?.runtimeInstalled ? 'model-ok' : 'model-missing'">
            {{ runtimeStatus.ai?.runtimeInstalled ? 'Installed' : 'Not installed' }}
          </strong>
          <small>{{ runtimeAiSummary }}</small>
        </div>
        <div>
          <span>Native host</span>
          <strong :class="runtimeStatus.nativeHost?.installed ? 'model-ok' : 'model-missing'">
            {{ runtimeStatus.nativeHost?.installed ? 'Registered' : 'Not registered' }}
          </strong>
          <small>Brave/Chrome companion launcher</small>
        </div>
        <div>
          <span>Tools</span>
          <strong>{{ runtimeToolSummary }}</strong>
          <small>ffmpeg, ffprobe, yt-dlp</small>
        </div>
      </div>

      <details class="runtime-details">
        <summary>Runtime paths</summary>
        <div class="info-grid">
          <div class="info-item">
            <label>Config</label>
            <code>{{ runtimeStatus.paths?.configDir || 'N/A' }}</code>
          </div>
          <div class="info-item">
            <label>Data</label>
            <code>{{ runtimeStatus.paths?.dataDir || 'N/A' }}</code>
          </div>
          <div class="info-item">
            <label>Models</label>
            <code>{{ runtimeStatus.paths?.modelsDir || 'N/A' }}</code>
          </div>
          <div class="info-item">
            <label>AI venv</label>
            <code>{{ runtimeStatus.paths?.aiVenv || 'N/A' }}</code>
          </div>
          <div class="info-item">
            <label>Logs</label>
            <code>{{ runtimeStatus.paths?.logsDir || 'N/A' }}</code>
          </div>
          <div class="info-item">
            <label>App</label>
            <code>{{ runtimeStatus.app?.appDir || 'N/A' }}</code>
          </div>
        </div>
      </details>

      <div class="form-actions">
        <button class="btn btn-secondary" @click="loadRuntimeStatus">Refresh Runtime Status</button>
      </div>
    </div>

    <div class="settings-section">
      <h2>App Updates</h2>
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
    </div>

    <div class="settings-section">
      <h2>Server Statistics</h2>
      <div v-if="statsLoading" class="stats-loading">Loading statistics...</div>
      <div v-else-if="statsError" class="stats-error">{{ statsError }}</div>
      <div v-else class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">{{ stats.total_files }}</div>
          <div class="stat-label">Total Files</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.images }}</div>
          <div class="stat-label">Images</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.gifs }}</div>
          <div class="stat-label">GIFs</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.videos }}</div>
          <div class="stat-label">Videos</div>
        </div>
        <div class="stat-card wide">
          <div class="stat-value">{{ stats.total_size_formatted }}</div>
          <div class="stat-label">Total Media Size</div>
        </div>
        <div class="stat-card wide">
          <div class="stat-value">{{ stats.database_size_formatted }}</div>
          <div class="stat-label">Database Size</div>
        </div>
        <div class="stat-card wide" v-if="stats.oldest_post">
          <div class="stat-value">{{ formatDate(stats.oldest_post) }}</div>
          <div class="stat-label">Oldest Post</div>
        </div>
        <div class="stat-card wide" v-if="stats.newest_post">
          <div class="stat-value">{{ formatDate(stats.newest_post) }}</div>
          <div class="stat-label">Newest Post</div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Auto Tagging</h2>
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

        <div class="model-list">
          <div v-for="model in modelCatalog" :key="model.id" class="model-row">
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
              <label class="pipeline-toggle">
                <input type="checkbox" v-model="autoTagSettings[modelSettingKey(model.id)]" />
                <span>
                  <strong>{{ modelPipelineLabel(model.id) }}</strong>
                  <small>{{ modelPipelineDescription(model.id) }}</small>
                </span>
              </label>
              <div v-if="model.id === 'qwen'" class="semantic-prompt-panel">
                <div class="semantic-prompt-head">
                  <div>
                    <strong>Semantic prompt</strong>
                    <small>Customize what Qwen should look for and which tags it should return.</small>
                  </div>
                  <button type="button" class="btn btn-secondary btn-small" @click="resetSemanticPrompt">
                    Reset
                  </button>
                </div>
                <textarea
                  v-model="autoTagSettings.semanticPrompt"
                  rows="7"
                  maxlength="4000"
                  spellcheck="true"
                  placeholder="Describe the semantic tags Qwen should look for..."
                ></textarea>
                <small class="semantic-prompt-note">
                  Used when Qwen is enabled for per-post, import, extension preview, or bulk auto-tagging. Keep requested tags in snake_case for best results.
                </small>
              </div>
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
                :class="{ 'btn-danger': modelDownloadActiveFor(model.id) }"
                @click="modelDownloadActiveFor(model.id) ? cancelModelDownload() : downloadAutoTagModelById(model.id)"
                :disabled="(!modelDownloadActiveFor(model.id) && (modelDownloadRunning || model.downloaded)) || modelDownloadCancelling"
              >
                {{ modelDownloadActiveFor(model.id) ? (modelDownloadCancelling ? 'Cancelling...' : 'Cancel') : (model.downloaded ? 'Downloaded' : 'Download') }}
              </button>
              <button
                class="btn btn-secondary"
                @click="model.loaded ? unloadAutoTagModelById(model.id) : loadAutoTagModelById(model.id)"
                :disabled="modelDownloadRunning || !model.downloaded || !model.runtimeAvailable || modelMemoryBusy"
              >
                {{ model.loaded ? 'Unload' : 'Load' }}
              </button>
              <button
                class="btn btn-danger"
                @click="deleteAutoTagModelById(model.id)"
                :disabled="modelDownloadRunning || !model.downloaded || modelDeleteBusy"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="config-panel">
        <div class="config-panel-head">
          <h3>Compute location</h3>
          <p>Run models in this server, or offload to a GPU machine on your LAN.</p>
        </div>
        <label class="toggle-card">
          <input type="checkbox" v-model="autoTagSettings.remoteEnabled" @change="saveAutoTagSettings" />
          <span>
            <strong>Run AI on a remote GPU worker</strong>
            <small>Forwards tagging to another NekoBooru instance that has the AI stack installed. This server stays light.</small>
          </span>
        </label>
        <div v-if="autoTagSettings.remoteEnabled" class="remote-worker-config">
          <div class="form-group">
            <label>Worker URL</label>
            <input
              v-model="autoTagSettings.remoteUrl"
              type="text"
              placeholder="http://192.168.1.50:8772"
              autocomplete="off"
              class="path-input"
            />
            <p class="help-text">The base URL of the GPU machine's NekoBooru (no trailing path).</p>
          </div>
          <div class="form-group">
            <label>Worker token</label>
            <div class="path-input-group">
              <input
                v-model="workerToken"
                type="password"
                placeholder="Shared secret (recommended)"
                autocomplete="off"
                class="path-input"
              />
              <button class="btn btn-secondary" @click="saveWorkerToken" :disabled="savingWorkerToken || !workerToken.trim()">
                {{ savingWorkerToken ? 'Saving...' : 'Save Token' }}
              </button>
              <button class="btn btn-secondary" @click="deleteWorkerToken" :disabled="savingWorkerToken || !autoTagStatus.remote?.tokenConfigured">
                Forget
              </button>
            </div>
            <p class="help-text">
              Must match <code>NEKO_TAGGER_WORKER_TOKEN</code> on the worker. Stored locally; sent as a header on each call.
            </p>
          </div>
          <div class="form-actions">
            <button class="btn" @click="testWorker" :disabled="testingWorker || !autoTagSettings.remoteUrl">
              {{ testingWorker ? 'Testing...' : 'Test connection' }}
            </button>
            <span class="status-note" :class="autoTagStatus.remote?.reachable ? 'model-ok' : 'model-missing'">
              {{ remoteWorkerSummary }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="!autoTagSettings.remoteEnabled" class="config-panel">
        <div class="config-panel-head">
          <h3>Compute Runtime</h3>
          <p>Choose where large torch models run. Auto prefers GPU when CUDA torch is installed.</p>
        </div>
        <div class="numeric-grid">
          <label class="field-row">
            <span class="label-with-help">
              Torch device
              <button type="button" class="info-icon" :data-tooltip="torchDeviceHelp" :aria-label="torchDeviceHelp">?</button>
            </span>
            <select v-model="autoTagSettings.torchDevice">
              <option value="auto">Auto</option>
              <option value="gpu">GPU only</option>
              <option value="cpu">CPU only</option>
            </select>
          </label>
          <div class="runtime-card">
            <strong>{{ torchSummary }}</strong>
            <small>{{ torchDeviceDetail }}</small>
          </div>
        </div>
      </div>

      <div class="config-panel">
        <div class="config-panel-head">
          <h3>Automation Scope</h3>
          <p>Choose where automatic tagging is allowed to run and what metadata it may update.</p>
        </div>
        <div class="toggle-grid">
          <label class="toggle-card">
            <input type="checkbox" v-model="autoTagSettings.tagImages" />
            <span>
              <strong>Images</strong>
              <small>Run image models on JPG, PNG, GIF, and WebP posts.</small>
            </span>
          </label>
          <label class="toggle-card">
            <input type="checkbox" v-model="autoTagSettings.tagVideos" />
            <span>
              <strong>Videos</strong>
              <small>Sample frames and optional audio/text context from video posts.</small>
            </span>
          </label>
          <label class="toggle-card">
            <input type="checkbox" v-model="autoTagSettings.applySafety" />
            <span>
              <strong>Safety updates</strong>
              <small>Promote posts to sketchy or unsafe when model evidence supports it.</small>
            </span>
          </label>
        </div>
      </div>

      <div class="config-panel">
        <div class="config-panel-head">
          <h3>Thresholds</h3>
          <p>Tune sensitivity, tag volume, and video frame sampling.</p>
        </div>
        <div class="numeric-grid">
          <label class="field-row">
            <span class="label-with-help">
              General threshold
              <button type="button" class="info-icon" :data-tooltip="thresholdHelp.general" :aria-label="thresholdHelp.general">?</button>
            </span>
            <input type="number" min="0" max="1" step="0.01" v-model.number="autoTagSettings.generalThreshold" />
          </label>
          <label class="field-row">
            <span class="label-with-help">
              Character threshold
              <button type="button" class="info-icon" :data-tooltip="thresholdHelp.character" :aria-label="thresholdHelp.character">?</button>
            </span>
            <input type="number" min="0" max="1" step="0.01" v-model.number="autoTagSettings.characterThreshold" />
          </label>
          <label class="field-row">
            <span class="label-with-help">
              Unsafe threshold
              <button type="button" class="info-icon" :data-tooltip="thresholdHelp.unsafe" :aria-label="thresholdHelp.unsafe">?</button>
            </span>
            <input type="number" min="0" max="1" step="0.01" v-model.number="autoTagSettings.unsafeThreshold" />
          </label>
          <label class="field-row">
            <span class="label-with-help">
              Sketchy threshold
              <button type="button" class="info-icon" :data-tooltip="thresholdHelp.sketchy" :aria-label="thresholdHelp.sketchy">?</button>
            </span>
            <input type="number" min="0" max="1" step="0.01" v-model.number="autoTagSettings.sketchyThreshold" />
          </label>
          <label class="field-row">
            <span class="label-with-help">
              Max tags
              <button type="button" class="info-icon" :data-tooltip="thresholdHelp.maxTags" :aria-label="thresholdHelp.maxTags">?</button>
            </span>
            <input type="number" min="1" max="200" v-model.number="autoTagSettings.maxTags" />
          </label>
          <label class="field-row">
            <span class="label-with-help">
              Video frames
              <button type="button" class="info-icon" :data-tooltip="thresholdHelp.videoFrames" :aria-label="thresholdHelp.videoFrames">?</button>
            </span>
            <input type="number" min="1" max="8" v-model.number="autoTagSettings.videoMaxFrames" />
          </label>
          <label class="field-row">
            <span class="label-with-help">
              Light tag cutoff
              <button type="button" class="info-icon" :data-tooltip="thresholdHelp.lightCutoff" :aria-label="thresholdHelp.lightCutoff">?</button>
            </span>
            <input type="number" min="0" max="50" v-model.number="autoTagSettings.lightlyTaggedMaxTags" />
          </label>
        </div>
      </div>

      <div class="config-panel">
        <div class="config-panel-head">
          <h3>Bulk Library Job</h3>
          <p>Run auto-tagging across existing posts using the saved defaults above.</p>
        </div>
        <div class="bulk-toolbar">
          <label class="field-row bulk-mode">
            <span>Target posts</span>
            <select v-model="autoTagMode">
              <option value="lightly_tagged">Lightly tagged</option>
              <option value="untagged">Untagged</option>
              <option value="videos">Videos</option>
              <option value="images">Images</option>
              <option value="all">All</option>
            </select>
          </label>
          <div class="bulk-actions">
            <div class="bulk-action-group">
              <span>Setup</span>
              <button class="btn action-tooltip" :data-tooltip="bulkActionHelp.save" @click="saveAutoTagSettings" :disabled="savingAutoTags">
                {{ savingAutoTags ? 'Saving...' : 'Save Settings' }}
              </button>
              <button class="btn btn-secondary action-tooltip" :data-tooltip="bulkActionHelp.estimate" @click="estimateAutoTags">Estimate</button>
            </div>
            <div class="bulk-action-group">
              <span>Review first</span>
              <button class="btn btn-secondary action-tooltip" :data-tooltip="bulkActionHelp.preview" @click="startAutoTagJob(true)" :disabled="autoTagJobRunning">
                Preview Job
              </button>
              <button
                class="btn btn-secondary action-tooltip"
                :data-tooltip="bulkActionHelp.viewPreview"
                @click="viewPreviewedJob"
                :disabled="!canViewPreview"
              >
                View Preview
              </button>
              <button
                class="btn action-tooltip"
                :data-tooltip="bulkActionHelp.applyPreview"
                @click="applyPreviewedJob"
                :disabled="!canApplyPreview"
              >
                Apply Preview
              </button>
            </div>
            <div class="bulk-action-group danger-zone">
              <span>Direct write</span>
              <button class="btn action-tooltip" :data-tooltip="bulkActionHelp.applyJob" @click="startAutoTagJob(false)" :disabled="autoTagJobRunning">
                Run & Apply
              </button>
              <button class="btn btn-danger action-tooltip" :data-tooltip="bulkActionHelp.cancel" @click="cancelAutoTagJob" :disabled="!autoTagJobRunning || autoTagJob?.status === 'cancelling'">
                {{ autoTagJob?.status === 'cancelling' ? 'Cancelling...' : 'Cancel' }}
              </button>
            </div>
          </div>
        </div>
        <div class="bulk-defaults-note">
          <strong>Models used</strong>
          <span>{{ bulkPipelineSummary }}</span>
        </div>

        <div v-if="autoTagEstimate" class="estimate-strip">
          <strong>Estimate</strong>
          <span>{{ autoTagEstimate.total }} total</span>
          <span>{{ autoTagEstimate.images }} images</span>
          <span>{{ autoTagEstimate.gifs }} GIFs</span>
          <span>{{ autoTagEstimate.videos }} videos</span>
        </div>

        <div v-if="autoTagJob" class="job-panel">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: autoTagProgressPercent + '%' }"></div>
          </div>
          <p>
            {{ autoTagJob.status }}:
            {{ autoTagJob.processed }} / {{ autoTagJob.total }}
            tagged {{ autoTagJob.tagged }},
            skipped {{ autoTagJob.skipped }},
            failed {{ autoTagJob.failed }}
          </p>
          <p v-if="autoTagJob.error" class="stats-error">{{ autoTagJob.error }}</p>
        </div>
      </div>
      </div>
    </div>

    <div v-if="showPreviewModal" class="modal-overlay" @click.self="showPreviewModal = false">
      <div class="preview-modal">
        <div class="modal-head">
          <div>
            <h2>Preview Suggestions</h2>
            <p>{{ previewSuggestions.length }} suggestion{{ previewSuggestions.length === 1 ? '' : 's' }} from job #{{ autoTagJob?.id }}</p>
          </div>
          <button class="btn btn-secondary" @click="showPreviewModal = false">Close</button>
        </div>
        <div v-if="previewLoading" class="stats-loading">Loading suggestions...</div>
        <div v-else-if="!previewSuggestions.length" class="empty-preview">
          No saved suggestions found for this preview job.
        </div>
        <div v-else class="preview-list">
          <div v-for="suggestion in previewSuggestions" :key="suggestion.id" class="preview-row">
            <div class="preview-row-head">
              <strong>Post #{{ suggestion.postId }}</strong>
              <span :class="suggestion.error ? 'model-missing' : 'model-ok'">{{ suggestion.error ? 'error' : suggestion.status }}</span>
            </div>
            <div class="preview-tags">
              <span v-for="tag in suggestion.suggestedTags.slice(0, 18)" :key="tag">{{ tag }}</span>
              <em v-if="suggestion.suggestedTags.length > 18">+{{ suggestion.suggestedTags.length - 18 }} more</em>
            </div>
            <p>
              Safety: <strong>{{ suggestion.suggestedSafety || 'unchanged' }}</strong>
              <span v-if="suggestion.error"> · {{ suggestion.error }}</span>
            </p>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showPreviewModal" class="modal-overlay" @click.self="showPreviewModal = false">
      <div class="preview-modal">
        <div class="modal-head">
          <div>
            <h2>Preview Suggestions</h2>
            <p>{{ previewSuggestions.length }} suggestion{{ previewSuggestions.length === 1 ? '' : 's' }} from job #{{ autoTagJob?.id }}</p>
          </div>
          <button class="btn btn-secondary" @click="showPreviewModal = false">Close</button>
        </div>
        <div v-if="previewLoading" class="stats-loading">Loading suggestions...</div>
        <div v-else-if="!previewSuggestions.length" class="empty-preview">
          No saved suggestions found for this preview job.
        </div>
        <div v-else class="preview-list">
          <div v-for="suggestion in previewSuggestions" :key="suggestion.id" class="preview-row">
            <div class="preview-row-head">
              <strong>Post #{{ suggestion.postId }}</strong>
              <span :class="suggestion.error ? 'model-missing' : 'model-ok'">{{ suggestion.error ? 'error' : suggestion.status }}</span>
            </div>
            <div class="preview-tags">
              <span v-for="tag in suggestion.suggestedTags.slice(0, 18)" :key="tag">{{ tag }}</span>
              <em v-if="suggestion.suggestedTags.length > 18">+{{ suggestion.suggestedTags.length - 18 }} more</em>
            </div>
            <p>
              Safety: <strong>{{ suggestion.suggestedSafety || 'unchanged' }}</strong>
              <span v-if="suggestion.error"> · {{ suggestion.error }}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import api from '../api/client'

const currentSettings = ref({})
const dataDir = ref('')
const saving = ref(false)
const isWindows = ref(navigator.platform.toLowerCase().includes('win'))
const SEARCH_PREDICTION_KEY = 'nekobooru.searchPredictionEnabled'
const NAME_PART_AUTOCOMPLETE_KEY = 'nekobooru.namePartAutocompleteEnabled'
const searchPredictionEnabled = ref(false)
const namePartAutocompleteEnabled = ref(false)
const serverSettings = ref({
  host: '127.0.0.1',
  port: 8772,
  frontend_port: 5173,
  cors_origins: '',
})
const savingServer = ref(false)
const serverStatus = ref({
  show: false,
  success: false,
  message: '',
})

const cookiesFileInput = ref(null)
const savingCookies = ref(false)
const cookiesStatus = ref({
  show: false,
  success: false,
  message: '',
})
const ytdlpStatus = ref({})
const ytdlpSettings = ref({
  updatePolicy: 'manual',
  pinnedVersion: '',
})
const ytdlpBusy = ref(false)
const ytdlpMessage = ref({
  show: false,
  success: false,
  message: '',
})
const runtimeStatus = ref({})
const updateStatus = ref({})
const updateSettings = ref({
  owner: 'm0nnnna',
  repo: 'NekoBooru',
  channel: 'stable',
  autoCheck: true,
  autoDownload: false,
  includePrereleases: false,
})
const updateBusy = ref(false)
const updateMessage = ref({
  show: false,
  success: false,
  message: '',
})
const aiRuntimeProfiles = ref([])
const selectedAiRuntimeProfile = ref('auto')
const aiRuntimeJob = ref(null)
const aiRuntimeBusy = ref(false)
const aiRuntimeMessage = ref({
  show: false,
  success: false,
  message: '',
})

const stats = ref({})
const statsLoading = ref(true)
const statsError = ref(null)
const autoTagSettings = ref({})
const autoTagStatus = ref({})
const autoTagMode = ref('lightly_tagged')
const autoTagEstimate = ref(null)
const autoTagJob = ref(null)
const showPreviewModal = ref(false)
const previewSuggestions = ref([])
const previewLoading = ref(false)
const savingAutoTags = ref(false)
const defaultSemanticPrompt = [
  'Return compact JSON only with keys tags, safety, rationale.',
  'Use snake_case tags. Look for higher-level context such as political_edit, meme_edit, amv, music_video, captioned, protest, politician, propaganda, and contextual edit signals only when visually or transcript supported.',
  'Use national_socialism only for clear Nazi/far-right symbols such as a swastika, sonnenrad, or black_sun.',
  'Use communism only for clear communist symbols such as a hammer_and_sickle or communist red star.',
  'If transcript or audio evidence suggests a song or music-driven edit, include music and edit.',
].join(' ')
const huggingFaceToken = ref('')
const savingToken = ref(false)
const modelCatalog = ref([])
const modelDownloadJob = ref(null)
const modelMemoryBusy = ref(false)
const modelDeleteBusy = ref(false)
const workerToken = ref('')
const savingWorkerToken = ref(false)
const testingWorker = ref(false)
const aiSetupTarget = ref('cuda')
const aiSetupCopied = ref(false)
const recheckingRuntime = ref(false)
const modelStatusMessage = ref({
  show: false,
  success: false,
  message: '',
})
const thresholdHelp = {
  general: 'Minimum confidence for general booru tags. Lower values add more tags but more noise; raise it if posts are getting vague or wrong tags. Typical range: 0.30-0.45.',
  character: 'Minimum confidence for character, copyright, and source tags. Lower it if known characters are missed; raise it if false character names appear. Typical range: 0.40-0.60.',
  unsafe: 'Explicit-rating confidence required before auto-tagging can promote a post to unsafe. Questionable/sensitive evidence can only promote to sketchy when it is very strong. Raise this to avoid false unsafe ratings.',
  sketchy: 'Confidence required before auto-tagging can promote a post to sketchy. The backend enforces a conservative floor so weak questionable/sensitive evidence does not relabel ordinary posts.',
  maxTags: 'Maximum number of tags kept from model output. Increase for richer search coverage; decrease if posts become cluttered. This limit applies before manual review.',
  videoFrames: 'Number of sampled video frames for visual tagging. More frames improve AMV/edit coverage but take longer. 3-4 is a good default; use 1 for fast middle-frame tagging.',
  lightCutoff: 'Posts with this many tags or fewer count as lightly tagged for bulk jobs. Increase to retag sparse libraries; decrease to only target nearly empty posts.',
}
const serverHelp = {
  host: '127.0.0.1 keeps NekoBooru available only on this PC. Use 0.0.0.0 only if you intentionally want LAN devices to reach it; NekoBooru has no built-in user login.',
  port: 'The TCP port for the backend and packaged web UI. Change it if another app already uses 8772. Restart required.',
  frontendPort: 'Dev/source mode only. Packaged installs serve the frontend from the backend port. Restart the Vite frontend dev server after changing this.',
  cors: 'Comma-separated browser origins allowed to call the API. Keep localhost/127.0.0.1 entries for the active port. Only add LAN origins you trust.',
}
const torchDeviceHelp = 'Auto uses CUDA/GPU when the installed torch build can see it, otherwise CPU. GPU only forces CUDA and reports an error if this venv has CPU-only torch. CPU only is slower but useful when you need VRAM free.'
const bulkActionHelp = {
  save: 'Save the default model choices, thresholds, compute setting, and safety options used by imports, per-post AI Tag, and bulk jobs.',
  estimate: 'Count how many posts match the selected target mode before starting a bulk job. This does not run any models.',
  preview: 'Run the saved enabled default models and save suggestions only. Existing tags and safety ratings are not changed until you click Apply Preview.',
  viewPreview: 'Open saved suggestions from the completed Preview Job so you can inspect tags, errors, and safety before applying them.',
  applyJob: 'Run the saved enabled default models and write tags/safety directly as each post finishes. This skips the review step.',
  applyPreview: 'Apply only the saved suggestions from a completed Preview Job. Disabled until a preview finishes successfully.',
  cancel: 'Request the current bulk job to stop. The current model call may finish first, then the job moves to cancelled.',
}
let autoTagPollTimer = null
let modelDownloadPollTimer = null
let ytdlpPollTimer = null
let aiRuntimePollTimer = null

const migrationPrompt = ref({
  show: false,
  old_path: '',
  new_path: '',
})

const migrationStatus = ref({
  show: false,
  success: false,
  message: '',
  details: null,
})

onMounted(async () => {
  loadSearchPredictionSetting()
  await Promise.all([loadSettings(), loadStats(), loadAutoTags(), refreshYtdlpStatus(), loadRuntimeStatus(), loadUpdateStatus(true)])
})

function loadSearchPredictionSetting() {
  searchPredictionEnabled.value = localStorage.getItem(SEARCH_PREDICTION_KEY) === 'true'
  namePartAutocompleteEnabled.value = localStorage.getItem(NAME_PART_AUTOCOMPLETE_KEY) === 'true'
}

function saveSearchPredictionSetting() {
  localStorage.setItem(SEARCH_PREDICTION_KEY, searchPredictionEnabled.value ? 'true' : 'false')
}

function saveNamePartAutocompleteSetting() {
  localStorage.setItem(NAME_PART_AUTOCOMPLETE_KEY, namePartAutocompleteEnabled.value ? 'true' : 'false')
}

onUnmounted(() => {
  if (autoTagPollTimer) clearInterval(autoTagPollTimer)
  if (modelDownloadPollTimer) clearInterval(modelDownloadPollTimer)
  if (ytdlpPollTimer) clearInterval(ytdlpPollTimer)
  if (aiRuntimePollTimer) clearInterval(aiRuntimePollTimer)
})

const autoTagJobRunning = computed(() =>
  autoTagJob.value && ['queued', 'running', 'cancelling'].includes(autoTagJob.value.status)
)

const canViewPreview = computed(() =>
  !!autoTagJob.value?.dryRun && ['completed', 'cancelled', 'failed'].includes(autoTagJob.value.status)
)

const canApplyPreview = computed(() =>
  !!autoTagJob.value?.dryRun && autoTagJob.value.status === 'completed' && !autoTagJobRunning.value
)

const ytdlpJobLabel = computed(() => {
  const status = ytdlpStatus.value.job?.status || 'idle'
  if (['queued', 'running'].includes(status)) return 'Updating'
  if (status === 'completed') return 'Updated'
  if (status === 'failed') return 'Needs attention'
  return 'No update running'
})

const ytdlpJobDetail = computed(() => {
  const job = ytdlpStatus.value.job || {}
  if (['queued', 'running'].includes(job.status)) return `Installing ${job.target || 'latest'}...`
  if (job.status === 'completed') {
    const after = job.after_version || ytdlpStatus.value.version
    return after ? `Installed ${after}` : 'Update completed'
  }
  if (job.status === 'failed') {
    return job.error || (job.output ? 'Open pip output for details' : 'Previous update failed before details were captured')
  }
  return ytdlpStatus.value.installed ? 'Manual updates are available below' : 'Install yt-dlp to enable page-based video downloads'
})

const ytdlpJobClass = computed(() => {
  const status = ytdlpStatus.value.job?.status || 'idle'
  if (status === 'completed') return 'model-ok'
  if (status === 'failed') return 'model-missing'
  return ''
})

const runtimeAiSummary = computed(() => {
  const ai = runtimeStatus.value.ai || {}
  if (ai.runtimeInstalled) return ai.profile || 'installed'
  const receiptError = ai.receipt?.error
  return receiptError ? `receipt error: ${receiptError}` : 'Install from Auto Tagging setup'
})

const runtimeToolSummary = computed(() => {
  const tools = runtimeStatus.value.tools || {}
  const ready = ['ffmpeg', 'ffprobe', 'ytdlp'].filter((key) => tools[key]?.available).length
  return `${ready}/3 ready`
})

const aiRuntimeProfileRows = computed(() => aiRuntimeProfiles.value.length
  ? aiRuntimeProfiles.value
  : [
      { id: 'auto', label: 'Auto-detect NVIDIA GPU', description: 'Pick GPU, legacy GPU, or CPU automatically.', downloadSize: '~3-8 GB', vram: 'Depends on models' },
      { id: 'cpu', label: 'Local CPU AI', description: 'No CUDA required. Slower, but simple.', downloadSize: '~3-5 GB', vram: '0 GB' },
      { id: 'gpu-cu128', label: 'Local NVIDIA AI', description: 'CUDA 12.8 for newer NVIDIA GPUs.', downloadSize: '~6-8 GB', vram: 'Model dependent' },
      { id: 'gpu-cu126-legacy', label: 'Local legacy NVIDIA AI', description: 'CUDA 12.6 for GTX 10-series/Pascal.', downloadSize: '~6-8 GB', vram: 'Model dependent' },
      { id: 'remote', label: 'Remote/server AI', description: 'Use another GPU machine instead of local CUDA wheels.', downloadSize: '0 GB on this client', vram: 'Remote worker' },
    ])

const aiRuntimeInstallProgress = computed(() => {
  if (!aiRuntimeJob.value) return 0
  return Math.max(0, Math.min(100, Number(aiRuntimeJob.value.progress || 0)))
})

const autoTagProgressPercent = computed(() => {
  if (!autoTagJob.value || !autoTagJob.value.total) return 0
  return Math.round((autoTagJob.value.processed / autoTagJob.value.total) * 100)
})

const modelDownloadRunning = computed(() =>
  modelDownloadJob.value && ['queued', 'running', 'cancelling'].includes(modelDownloadJob.value.status)
)

const modelDownloadCancelling = computed(() =>
  modelDownloadJob.value?.status === 'cancelling'
)

const downloadJobModels = computed(() =>
  Object.values(modelDownloadJob.value?.models || {})
)

const downloadJobTotal = computed(() =>
  downloadJobModels.value.length || modelCatalog.value.length
)

const downloadJobCompleted = computed(() =>
  downloadJobModels.value.filter((model) => ['completed', 'skipped'].includes(model.status)).length
)

const downloadJobFailed = computed(() =>
  downloadJobModels.value.filter((model) => model.status === 'failed').length
)

const downloadJobRunningRows = computed(() =>
  downloadJobModels.value.filter((model) => ['queued', 'running', 'cancelling'].includes(model.status))
)

const downloadJobActiveRow = computed(() =>
  downloadJobModels.value.find((model) => model.status === 'running') ||
  downloadJobModels.value.find((model) => model.status === 'cancelling') ||
  downloadJobModels.value.find((model) => model.status === 'queued') ||
  null
)

const downloadJobProgress = computed(() => {
  if (!downloadJobTotal.value) return 0
  const progress = downloadJobModels.value.reduce((total, model) => {
    if (['completed', 'skipped'].includes(model.status)) return total + 1
    if (!['running', 'cancelling'].includes(model.status)) return total
    return total + modelProgressFraction(model)
  }, 0)
  return Math.max(0, Math.min(100, Math.round((progress / downloadJobTotal.value) * 100)))
})

const downloadJobTitle = computed(() => {
  if (!modelDownloadJob.value) return ''
  if (modelDownloadJob.value.status === 'completed') return 'Model downloads complete'
  if (modelDownloadJob.value.status === 'failed') return 'Model downloads finished with errors'
  if (modelDownloadJob.value.status === 'cancelled') return 'Model download cancelled'
  if (modelDownloadJob.value.status === 'cancelling') return 'Cancelling model download'
  return 'Downloading model weights'
})

const downloadJobCounts = computed(() =>
  `${downloadJobCompleted.value}/${downloadJobTotal.value} done${downloadJobFailed.value ? `, ${downloadJobFailed.value} failed` : ''}`
)

const downloadJobDetail = computed(() => {
  const active = downloadJobActiveRow.value
  if (active) {
    const bytes = downloadBytesLabel(active)
    const current = active.current || active.status
    return `${active.name || active.modelId}: ${modelProgressPercent(active.id)}% ${current}${bytes ? ` - ${bytes}` : ' - waiting for file progress'}`
  }
  if (downloadJobFailed.value) return 'Check the model rows below for the failure details.'
  if (modelDownloadJob.value?.status === 'cancelled') return 'Download was cancelled. Already completed model files were kept.'
  if (downloadJobTotal.value && downloadJobCompleted.value === downloadJobTotal.value) {
    return 'All selected models are downloaded.'
  }
  return 'Waiting for download status.'
})

const downloadedModelCount = computed(() =>
  modelCatalog.value.filter((model) => model.downloaded).length
)

const loadedModelCount = computed(() =>
  modelCatalog.value.filter((model) => model.loaded).length
)

const missingRuntimeModels = computed(() =>
  modelCatalog.value.filter((model) => !model.runtimeAvailable)
)

const enabledModels = computed(() =>
  modelCatalog.value.filter((model) => isModelEnabled(model.id))
)

const enabledModelNames = computed(() =>
  enabledModels.value.map((model) => model.name).join(', ')
)

const enabledModelsMissingDownloads = computed(() =>
  enabledModels.value.filter((model) => !model.downloaded)
)

const bulkPipelineSummary = computed(() => {
  const names = enabledModels.value.map((model) => model.name)
  const modelText = names.length
    ? names.join(', ')
    : 'No models enabled. Save defaults in Model Registry first.'
  const target = {
    lightly_tagged: 'lightly tagged posts',
    untagged: 'untagged posts',
    videos: 'video posts',
    images: 'image posts',
    all: 'the whole library',
  }[autoTagMode.value] || 'selected posts'
  return `Bulk jobs process ${target} using saved enabled defaults only: ${modelText}. Downloaded but unchecked models are skipped.`
})

const aiRuntimeMissing = computed(() => {
  // When offloading to a remote worker, the runtime lives on the worker, not here.
  if (autoTagSettings.value.remoteEnabled) return false
  const deps = autoTagStatus.value.dependencies || {}
  // Nothing can run without at least an inference runtime. ONNX powers the
  // baseline WD/Camie taggers; torch powers OCR/Whisper/Qwen.
  return !deps.onnxruntime && !deps.torch
})

const remoteWorkerSummary = computed(() => {
  const remote = autoTagStatus.value.remote || {}
  if (!autoTagSettings.value.remoteEnabled) return 'Local inference'
  if (!remote.url) return 'Enter the worker URL'
  if (remote.reachable) {
    const torch = remote.worker?.torch || {}
    const where = torch.cudaAvailable
      ? `GPU: ${torch.devices?.[0]?.name || 'CUDA'}`
      : (torch.available ? 'worker on CPU' : 'worker has no torch')
    return `Connected · ${where}`
  }
  return remote.error ? `Unreachable (${remote.error})` : 'Not connected — Test connection'
})

const aiSetupCommand = computed(() =>
  ({
    cpu: 'nekobooru --install-ai --profile cpu',
    'gpu-cu128': 'nekobooru --install-ai --profile gpu-cu128',
    'gpu-cu126-legacy': 'nekobooru --install-ai --profile gpu-cu126-legacy',
    remote: 'Configure remote/server AI worker below; no local CUDA wheels are installed.',
    auto: 'nekobooru --install-ai --profile auto',
  }[selectedAiRuntimeProfile.value] || 'nekobooru --install-ai --profile auto')
)

const effectiveTorch = computed(() => {
  const remote = autoTagStatus.value.remote || {}
  if (autoTagSettings.value.remoteEnabled && remote.reachable && remote.worker?.torch) {
    return remote.worker.torch
  }
  return autoTagStatus.value.torch || {}
})

const effectiveOnnxReady = computed(() => {
  const remote = autoTagStatus.value.remote || {}
  if (autoTagSettings.value.remoteEnabled && remote.reachable && remote.worker?.onnx) {
    return !!remote.worker.onnx.availableProviders?.length || !!remote.worker.onnx.available
  }
  return !!autoTagStatus.value.dependencies?.onnxruntime
})

const torchSummary = computed(() => {
  const torch = effectiveTorch.value
  if (!torch.available) return 'Torch missing'
  if (!torch.cudaAvailable) return 'CPU only'
  const first = torch.devices?.[0]
  return first ? `GPU: ${first.name}` : 'CUDA ready'
})

const torchDeviceDetail = computed(() => {
  const torch = effectiveTorch.value
  const qwen = autoTagStatus.value.qwenDevice || {}
  if (!torch.available) return 'Install torch before using Qwen, OCR, or Whisper.'
  if (!torch.cudaAvailable) return 'CUDA is not available to the active AI runtime. Qwen will load on CPU unless you install a CUDA torch wheel or connect a GPU worker.'
  const devices = (torch.devices || [])
    .map((device) => `${device.name} ${device.totalMemoryGb} GB VRAM`)
    .join(', ')
  const loaded = qwen.loaded ? `Qwen loaded via ${qwen.device || 'device map'}.` : 'Qwen is not loaded.'
  return `${devices || 'CUDA device detected'}. ${loaded}`
})

function modelSettingKey(id) {
  return {
    wd: 'wdEnabled',
    camie: 'characterModelEnabled',
    ocr: 'ocrEnabled',
    whisper: 'whisperEnabled',
    qwen: 'qwenEnabled',
  }[id] || `${id}Enabled`
}

function modelPipelineLabel(id) {
  return {
    wd: 'Enable by default for booru tags',
    camie: 'Enable by default for character/source tags',
    ocr: 'Enable by default for text extraction',
    whisper: 'Enable by default for audio transcripts',
    qwen: 'Enable by default for semantic tags',
  }[id] || 'Enable by default'
}

function modelPipelineDescription(id) {
  return {
    wd: 'Runs on images and sampled video frames. Best baseline for visual library tags.',
    camie: 'Adds anime characters, copyright/source tags, artist tags, and rating evidence.',
    ocr: 'Reads visible captions, subtitles, and meme text from representative frames.',
    whisper: 'Extracts speech from video audio for AMVs, edits, narration, and spoken context.',
    qwen: 'Uses image plus OCR/transcript context for higher-level edit and scene meaning.',
  }[id] || 'Use this model in the saved default auto-tagging pipeline.'
}

function modelInfoTitle(model) {
  return [
    model.name,
    model.purpose,
    modelPipelineDescription(model.id),
    `Download size: ${model.downloadSize || 'Unknown'}`,
    `VRAM: ${model.vramRequirement || 'Unknown'}`,
    `Runtime: ${model.runtimeAvailable ? 'ready' : 'missing'}`,
    `Memory: ${model.loaded ? 'loaded' : 'not loaded'}`,
    model.providers?.length ? `Provider: ${model.providers.join(', ')}` : null,
  ].filter(Boolean).join('\n')
}

function isModelEnabled(id) {
  const key = modelSettingKey(id)
  if (id === 'wd') return autoTagSettings.value[key] !== false
  return Boolean(autoTagSettings.value[key])
}

async function loadStats() {
  statsLoading.value = true
  statsError.value = null
  try {
    stats.value = await api.getStats()
  } catch (e) {
    statsError.value = 'Failed to load statistics: ' + e.message
  } finally {
    statsLoading.value = false
  }
}

async function loadRuntimeStatus() {
  try {
    const [status, profiles] = await Promise.all([
      api.getRuntimeStatus(),
      api.getAiRuntimeProfiles(),
    ])
    runtimeStatus.value = status || {}
    aiRuntimeProfiles.value = profiles.profiles || []
    aiRuntimeJob.value = profiles.installJob || aiRuntimeJob.value
    aiRuntimeBusy.value = ['queued', 'running', 'cancelling'].includes(aiRuntimeJob.value?.status)
    if (aiRuntimeBusy.value) startAiRuntimePolling()
  } catch (e) {
    aiRuntimeMessage.value = {
      show: true,
      success: false,
      message: 'Failed to load runtime status: ' + e.message,
    }
  }
}

async function startAiRuntimeInstall() {
  aiRuntimeBusy.value = true
  aiRuntimeMessage.value = {
    show: true,
    success: true,
    message: 'Starting AI runtime install. Large CUDA wheels can take a while.',
  }
  try {
    aiRuntimeJob.value = await api.installAiRuntime(selectedAiRuntimeProfile.value)
    if (aiRuntimeJob.value?.status === 'completed') {
      aiRuntimeBusy.value = false
      aiRuntimeMessage.value = {
        show: true,
        success: true,
        message: aiRuntimeJob.value.message || 'AI runtime is already installed.',
      }
      await Promise.all([loadRuntimeStatus(), refreshAutoTagStatus()])
      return
    }
    startAiRuntimePolling()
  } catch (e) {
    aiRuntimeBusy.value = false
    aiRuntimeMessage.value = {
      show: true,
      success: false,
      message: 'Failed to start AI runtime install: ' + e.message,
    }
  }
}

async function cancelAiRuntimeInstall() {
  try {
    aiRuntimeJob.value = await api.cancelAiRuntimeInstall()
    aiRuntimeMessage.value = {
      show: true,
      success: false,
      message: 'AI runtime install cancellation requested.',
    }
  } catch (e) {
    aiRuntimeMessage.value = {
      show: true,
      success: false,
      message: 'Failed to cancel AI runtime install: ' + e.message,
    }
  }
}

function startAiRuntimePolling() {
  if (aiRuntimePollTimer) clearInterval(aiRuntimePollTimer)
  aiRuntimePollTimer = setInterval(async () => {
    try {
      aiRuntimeJob.value = await api.getAiRuntimeInstallJob()
      aiRuntimeBusy.value = ['queued', 'running', 'cancelling'].includes(aiRuntimeJob.value?.status)
      if (!aiRuntimeBusy.value) {
        clearInterval(aiRuntimePollTimer)
        aiRuntimePollTimer = null
        const ok = aiRuntimeJob.value?.status === 'completed'
        aiRuntimeMessage.value = {
          show: true,
          success: ok,
          message: ok
            ? 'AI runtime install completed.'
            : `AI runtime install failed: ${aiRuntimeJob.value?.error || 'open installer output for details'}`,
        }
        await Promise.all([loadRuntimeStatus(), refreshAutoTagStatus()])
      }
    } catch (e) {
      clearInterval(aiRuntimePollTimer)
      aiRuntimePollTimer = null
      aiRuntimeBusy.value = false
      aiRuntimeMessage.value = {
        show: true,
        success: false,
        message: 'Failed to poll AI runtime install: ' + e.message,
      }
    }
  }, 1500)
}

function formatDate(isoString) {
  if (!isoString) return 'N/A'
  const date = new Date(isoString)
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function applyUpdateStatus(result) {
  updateStatus.value = result || {}
  const raw = updateStatus.value.settings || {}
  updateSettings.value = {
    owner: raw.owner || 'm0nnnna',
    repo: raw.repo || 'NekoBooru',
    channel: raw.channel || 'stable',
    autoCheck: raw.autoCheck !== false,
    autoDownload: raw.autoDownload === true,
    includePrereleases: raw.includePrereleases === true,
  }
}

async function loadUpdateStatus(auto = false) {
  try {
    applyUpdateStatus(await api.getUpdateStatus(auto))
  } catch (e) {
    updateMessage.value = {
      show: true,
      success: false,
      message: 'Failed to load update status: ' + e.message,
    }
  }
}

async function saveUpdateSettings() {
  updateBusy.value = true
  updateMessage.value.show = false
  try {
    applyUpdateStatus(await api.updateUpdateSettings({
      ...updateSettings.value,
      includePrereleases: updateSettings.value.channel === 'prerelease',
    }))
    updateMessage.value = {
      show: true,
      success: true,
      message: 'Update settings saved.',
    }
  } catch (e) {
    updateMessage.value = {
      show: true,
      success: false,
      message: 'Failed to save update settings: ' + e.message,
    }
  } finally {
    updateBusy.value = false
  }
}

async function checkForUpdates() {
  updateBusy.value = true
  updateMessage.value = {
    show: true,
    success: true,
    message: 'Checking GitHub Releases...',
  }
  try {
    applyUpdateStatus(await api.checkForUpdates())
    const check = updateStatus.value.lastCheck || {}
    updateMessage.value = {
      show: true,
      success: !check.error,
      message: check.message || 'Update check completed.',
    }
  } catch (e) {
    updateMessage.value = {
      show: true,
      success: false,
      message: 'Failed to check for updates: ' + e.message,
    }
  } finally {
    updateBusy.value = false
  }
}

async function loadSettings() {
  try {
    currentSettings.value = await api.getSettings()
    dataDir.value = currentSettings.value.data_dir || ''
    serverSettings.value = {
      host: currentSettings.value.host || '127.0.0.1',
      port: currentSettings.value.port || 8772,
      frontend_port: currentSettings.value.frontend_port || 5173,
      cors_origins: currentSettings.value.cors_origins || '',
    }
  } catch (e) {
    alert('Failed to load settings: ' + e.message)
  }
}

async function saveServerSettings() {
  savingServer.value = true
  serverStatus.value.show = false
  try {
    const result = await api.updateServerSettings({
      host: serverSettings.value.host,
      port: Number(serverSettings.value.port || 8772),
      frontend_port: Number(serverSettings.value.frontend_port || 5173),
      cors_origins: serverSettings.value.cors_origins,
    })
    serverStatus.value = {
      show: true,
      success: true,
      message: result.restartRequired
        ? 'Server settings saved. Restart NekoBooru and the dev frontend to use new ports.'
        : 'Server settings saved.',
    }
    await loadSettings()
  } catch (e) {
    serverStatus.value = {
      show: true,
      success: false,
      message: 'Failed to save server settings: ' + e.message,
    }
  } finally {
    savingServer.value = false
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
    }
    autoTagStatus.value = statusResult
    autoTagJob.value = currentJob
    modelCatalog.value = modelsResult.models || []
    modelDownloadJob.value = modelsResult.downloadJob
    if (autoTagJobRunning.value) startAutoTagPolling()
    if (modelDownloadRunning.value) startModelDownloadPolling()
  } catch (e) {
    console.error('Failed to load auto tag settings:', e)
  }
}

async function saveAutoTagSettings() {
  savingAutoTags.value = true
  try {
    autoTagSettings.value.semanticPrompt = (autoTagSettings.value.semanticPrompt || defaultSemanticPrompt).trim()
    autoTagSettings.value = await api.updateAutoTagSettings(autoTagSettings.value)
    autoTagStatus.value = await api.getAutoTagStatus()
  } catch (e) {
    alert('Failed to save auto tag settings: ' + e.message)
  } finally {
    savingAutoTags.value = false
  }
}

function resetSemanticPrompt() {
  autoTagSettings.value.semanticPrompt = defaultSemanticPrompt
}

async function refreshAutoTagStatus() {
  try {
    const [statusResult, modelsResult] = await Promise.all([
      api.getAutoTagStatus(),
      api.getAutoTagModels(),
    ])
    autoTagStatus.value = statusResult
    modelCatalog.value = modelsResult.models || []
    modelDownloadJob.value = modelsResult.downloadJob
  } catch (e) {
    alert('Failed to refresh auto tag status: ' + e.message)
  }
}

async function recheckAiRuntime() {
  recheckingRuntime.value = true
  try {
    await refreshAutoTagStatus()
  } finally {
    recheckingRuntime.value = false
  }
}

async function copyAiSetupCommand() {
  try {
    await navigator.clipboard.writeText(aiSetupCommand.value)
    aiSetupCopied.value = true
    setTimeout(() => { aiSetupCopied.value = false }, 1500)
  } catch (e) {
    // Clipboard may be unavailable (e.g. non-secure context); leave the command
    // visible for manual copy.
  }
}

async function saveHuggingFaceToken() {
  if (!huggingFaceToken.value.trim()) return
  savingToken.value = true
  modelStatusMessage.value.show = false
  try {
    autoTagStatus.value = await api.saveHuggingFaceToken(huggingFaceToken.value.trim())
    huggingFaceToken.value = ''
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: 'Hugging Face token saved.',
    }
  } catch (e) {
    modelStatusMessage.value = {
      show: true,
      success: false,
      message: 'Failed to save Hugging Face token: ' + e.message,
    }
  } finally {
    savingToken.value = false
  }
}

async function deleteHuggingFaceToken() {
  savingToken.value = true
  modelStatusMessage.value.show = false
  try {
    autoTagStatus.value = await api.deleteHuggingFaceToken()
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: 'Hugging Face token removed.',
    }
  } catch (e) {
    modelStatusMessage.value = {
      show: true,
      success: false,
      message: 'Failed to remove Hugging Face token: ' + e.message,
    }
  } finally {
    savingToken.value = false
  }
}

async function saveWorkerToken() {
  if (!workerToken.value.trim()) return
  savingWorkerToken.value = true
  try {
    autoTagStatus.value = await api.saveTaggerWorkerToken(workerToken.value.trim())
    workerToken.value = ''
  } catch (e) {
    alert('Failed to save worker token: ' + e.message)
  } finally {
    savingWorkerToken.value = false
  }
}

async function deleteWorkerToken() {
  savingWorkerToken.value = true
  try {
    autoTagStatus.value = await api.deleteTaggerWorkerToken()
  } catch (e) {
    alert('Failed to remove worker token: ' + e.message)
  } finally {
    savingWorkerToken.value = false
  }
}

async function testWorker() {
  testingWorker.value = true
  try {
    // Persist URL/enabled first so the backend probes the right worker.
    await saveAutoTagSettings()
    await refreshAutoTagStatus()
  } finally {
    testingWorker.value = false
  }
}

async function downloadAutoTagModelById(id) {
  const model = modelCatalog.value.find((row) => row.id === id)
  if (model?.downloaded) {
    modelDownloadJob.value = optimisticDownloadJob([id], { status: 'completed' })
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: `${model.name} is already downloaded.`,
    }
    return
  }

  modelDownloadJob.value = optimisticDownloadJob([id])
  modelStatusMessage.value = {
    show: true,
    success: true,
    message: `Starting ${model?.name || 'model'} download. Large models can take a while.`,
  }
  try {
    modelDownloadJob.value = await api.downloadAutoTagModelById(id)
    await pollModelDownloadOnce()
    startModelDownloadPolling()
  } catch (e) {
    modelStatusMessage.value = {
      show: true,
      success: false,
      message: 'Failed to start model download: ' + e.message,
    }
  }
}

async function downloadAllAutoTagModels() {
  const ids = modelCatalog.value.map((model) => model.id)
  const missing = modelCatalog.value.filter((model) => !model.downloaded)
  if (!missing.length) {
    modelDownloadJob.value = optimisticDownloadJob(ids, { status: 'completed' })
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: 'All models are already downloaded.',
    }
    return
  }

  modelDownloadJob.value = optimisticDownloadJob(ids)
  modelStatusMessage.value = {
    show: true,
    success: true,
    message: `Starting ${missing.length} model download${missing.length === 1 ? '' : 's'}. Already downloaded models are marked complete.`,
  }
  try {
    modelDownloadJob.value = await api.downloadAllAutoTagModels()
    await pollModelDownloadOnce()
    startModelDownloadPolling()
  } catch (e) {
    modelStatusMessage.value = {
      show: true,
      success: false,
      message: 'Failed to start model downloads: ' + e.message,
    }
  }
}

async function loadAutoTagModelById(id) {
  const model = modelCatalog.value.find((row) => row.id === id)
  modelMemoryBusy.value = true
  modelStatusMessage.value = {
    show: true,
    success: true,
    message: `Loading ${model?.name || 'model'} into memory.`,
  }
  try {
    await api.loadAutoTagModelById(id)
    await waitForModelLoad()
    await refreshAutoTagStatus()
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: `${model?.name || 'Model'} loaded into memory.`,
    }
  } catch (e) {
    modelStatusMessage.value = {
      show: true,
      success: false,
      message: 'Failed to load model: ' + e.message,
    }
  } finally {
    modelMemoryBusy.value = false
  }
}

async function unloadAutoTagModelById(id) {
  const model = modelCatalog.value.find((row) => row.id === id)
  modelMemoryBusy.value = true
  try {
    const result = await api.unloadAutoTagModelById(id)
    modelCatalog.value = result.models || modelCatalog.value
    autoTagStatus.value = await api.getAutoTagStatus()
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: result.unloaded
        ? `${model?.name || 'Model'} unloaded from memory.`
        : `${model?.name || 'Model'} was already unloaded.`,
    }
  } catch (e) {
    modelStatusMessage.value = {
      show: true,
      success: false,
      message: 'Failed to unload model: ' + e.message,
    }
  } finally {
    modelMemoryBusy.value = false
  }
}

async function deleteAutoTagModelById(id) {
  const model = modelCatalog.value.find((row) => row.id === id)
  if (!model?.downloaded) return
  const confirmed = window.confirm(`Delete downloaded files for ${model.name}? You can download them again later.`)
  if (!confirmed) return

  modelDeleteBusy.value = true
  try {
    const result = await api.deleteAutoTagModelById(id)
    modelCatalog.value = result.models || modelCatalog.value
    autoTagStatus.value = await api.getAutoTagStatus()
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: result.deleted
        ? `${model.name} files deleted.`
        : `${model.name} files were already absent.`,
    }
  } catch (e) {
    modelStatusMessage.value = {
      show: true,
      success: false,
      message: 'Failed to delete model files: ' + e.message,
    }
  } finally {
    modelDeleteBusy.value = false
  }
}

async function waitForModelLoad() {
  for (let i = 0; i < 600; i += 1) {
    const job = await api.getAutoTagModelLoadJob()
    if (!job || !['queued', 'running'].includes(job.status)) {
      if (job?.status === 'failed') throw new Error(job.error || 'Model load failed')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new Error('Timed out waiting for model load')
}

function optimisticDownloadJob(ids, options = {}) {
  const status = options.status || 'running'
  const now = Date.now() / 1000
  const rows = {}
  let queuedStarted = false
  for (const id of ids) {
    const model = modelCatalog.value.find((row) => row.id === id) || { id, name: id, repoId: id }
    const alreadyDone = status === 'completed' || model.downloaded
    const rowStatus = alreadyDone ? 'completed' : queuedStarted ? 'queued' : 'running'
    if (!alreadyDone && !queuedStarted) queuedStarted = true
    rows[id] = {
      id,
      modelId: id,
      name: model.name,
      repoId: model.repoId,
      status: rowStatus,
      current: alreadyDone ? 'Already downloaded' : rowStatus === 'running' ? 'Starting download' : 'Waiting',
      bytesDownloaded: 0,
      bytesTotal: 0,
      error: null,
    }
  }
  const total = Object.keys(rows).length
  const completed = Object.values(rows).filter((row) => row.status === 'completed').length
  return {
    id: `local-${Math.round(now * 1000)}`,
    status: completed === total ? 'completed' : 'running',
    modelIds: ids,
    models: rows,
    completed,
    failed: 0,
    total,
    startedAt: now,
    updatedAt: now,
  }
}

async function pollModelDownloadOnce() {
  const job = await api.getAutoTagModelDownloadJob()
  if (job) modelDownloadJob.value = job
  if (!job || !['queued', 'running', 'cancelling'].includes(job.status)) {
    const modelsResult = await api.getAutoTagModels()
    modelCatalog.value = modelsResult.models || modelCatalog.value
  }
}

function startModelDownloadPolling() {
  if (modelDownloadPollTimer) clearInterval(modelDownloadPollTimer)
  modelDownloadPollTimer = setInterval(async () => {
    try {
      await pollModelDownloadOnce()
      if (!modelDownloadRunning.value && modelDownloadPollTimer) {
        clearInterval(modelDownloadPollTimer)
        modelDownloadPollTimer = null
        autoTagStatus.value = await api.getAutoTagStatus()
        modelStatusMessage.value = {
          show: true,
          success: modelDownloadJob.value?.status === 'completed' || modelDownloadJob.value?.status === 'cancelled',
          message: modelDownloadJob.value?.status === 'completed'
            ? 'Model downloads completed.'
            : modelDownloadJob.value?.status === 'cancelled'
              ? 'Model download cancelled.'
            : 'One or more model downloads failed.',
        }
      }
    } catch (e) {
      console.error('Failed to poll model download:', e)
    }
  }, 1000)
}

async function cancelModelDownload() {
  if (!modelDownloadRunning.value || modelDownloadCancelling.value) return
  try {
    modelDownloadJob.value = await api.cancelAutoTagModelDownloadJob()
    startModelDownloadPolling()
  } catch (e) {
    modelStatusMessage.value = {
      show: true,
      success: false,
      message: 'Failed to cancel model download: ' + e.message,
    }
  }
}

function modelDownloadState(id) {
  return modelDownloadJob.value?.models?.[id] || null
}

function modelDownloadActiveFor(id) {
  const state = modelDownloadState(id)
  return !!state && ['queued', 'running', 'cancelling'].includes(state.status)
}

function modelProgressPercent(id) {
  const state = modelDownloadState(id)
  if (!state) return 0
  if (state.status === 'completed') return 100
  return Math.round(modelProgressFraction(state) * 100)
}

function modelProgressFraction(state) {
  if (!state) return 0
  if (['completed', 'skipped'].includes(state.status)) return 1
  if (state.status === 'failed') return 0
  if (state.bytesTotal) {
    return Math.max(0.02, Math.min(0.99, Number(state.bytesDownloaded || 0) / Number(state.bytesTotal)))
  }
  if (state.status === 'running' || state.status === 'cancelling') return 0.08
  if (state.status === 'queued') return 0.02
  return 0
}

function modelDownloadStateLabel(id) {
  const state = modelDownloadState(id)
  if (!state) return ''
  if (state.status === 'completed') return 'completed'
  if (state.status === 'running') return 'downloading'
  if (state.status === 'cancelling') return 'cancelling'
  if (state.status === 'cancelled') return 'cancelled'
  if (state.status === 'queued') return 'queued'
  if (state.status === 'failed') return 'failed'
  return state.status || ''
}

function modelDownloadBytes(id) {
  const state = modelDownloadState(id)
  return downloadBytesLabel(state)
}

function downloadBytesLabel(state) {
  if (!state?.bytesTotal) return ''
  return `${formatBytes(state.bytesDownloaded)} / ${formatBytes(state.bytesTotal)}`
}

function modelStatusLabel(status) {
  if (status === 'tagging_ready') return 'Tagging ready'
  if (status === 'download_only') return 'Download only'
  return status || 'Unknown'
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = units.shift()
  while (size >= 1024 && units.length) {
    size /= 1024
    unit = units.shift()
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`
}

async function estimateAutoTags() {
  try {
    autoTagEstimate.value = await api.estimateAutoTagJob(autoTagMode.value)
  } catch (e) {
    alert('Failed to estimate auto tag job: ' + e.message)
  }
}

async function startAutoTagJob(dryRun) {
  try {
    await saveAutoTagSettings()
    previewSuggestions.value = []
    showPreviewModal.value = false
    autoTagJob.value = await api.createAutoTagJob({
      mode: autoTagMode.value,
      dryRun,
      settings: autoTagSettings.value,
    })
    startAutoTagPolling()
  } catch (e) {
    alert('Failed to start auto tag job: ' + e.message)
  }
}

function startAutoTagPolling() {
  if (autoTagPollTimer) clearInterval(autoTagPollTimer)
  autoTagPollTimer = setInterval(async () => {
    if (!autoTagJob.value?.id) return
    try {
      autoTagJob.value = await api.getAutoTagJob(autoTagJob.value.id)
      if (!autoTagJobRunning.value && autoTagPollTimer) {
        clearInterval(autoTagPollTimer)
        autoTagPollTimer = null
      }
    } catch (e) {
      console.error('Failed to poll auto tag job:', e)
    }
  }, 1500)
}

async function cancelAutoTagJob() {
  if (!autoTagJob.value?.id) return
  try {
    autoTagJob.value = await api.cancelAutoTagJob(autoTagJob.value.id)
  } catch (e) {
    alert('Failed to cancel auto tag job: ' + e.message)
  }
}

async function viewPreviewedJob() {
  if (!autoTagJob.value?.id) return

  showPreviewModal.value = true
  previewLoading.value = true

  try {
    previewSuggestions.value = await api.getAutoTagJobSuggestions(autoTagJob.value.id, {
      page: 1,
      limit: 100,
    })
  } catch (e) {
    alert('Failed to load preview suggestions: ' + e.message)
  } finally {
    previewLoading.value = false
  }
}

async function applyPreviewedJob() {
  if (!autoTagJob.value?.id || !canApplyPreview.value) {
    alert('Run Preview Job first, wait for it to complete, then use View Preview or Apply Preview.')
    return
  }

  try {
    const suggestions = previewSuggestions.value.length
      ? previewSuggestions.value
      : await api.getAutoTagJobSuggestions(autoTagJob.value.id, { page: 1, limit: 100 })
    const applicableSuggestions = suggestions.filter((suggestion) =>
      suggestion.status === 'suggested' && !suggestion.error
    )

    if (!applicableSuggestions.length) {
      alert('This preview job has no successful suggestions to apply. Open View Preview to inspect skipped posts or errors.')
      return
    }

    const result = await api.applyAutoTagJob(autoTagJob.value.id)
    alert(`Applied ${result.applied} suggestion${result.applied === 1 ? '' : 's'}`)
    autoTagJob.value = await api.getAutoTagJob(autoTagJob.value.id)
    if (showPreviewModal.value) {
      await viewPreviewedJob()
    }
  } catch (e) {
    alert('Failed to apply previewed job: ' + e.message)
  }
}

async function saveSettings() {
  if (!dataDir.value.trim()) {
    alert('Please enter a data directory path')
    return
  }

  saving.value = true
  migrationPrompt.show = false
  migrationStatus.show = false

  try {
    const result = await api.updateDataDir(dataDir.value.trim(), false)
    
    if (result.needs_migration) {
      // Show migration prompt
      migrationPrompt.value = {
        show: true,
        old_path: result.old_path,
        new_path: result.new_path,
      }
    } else {
      // Successfully updated
      await loadSettings()
      alert('Settings saved successfully!')
    }
  } catch (e) {
    alert('Failed to save settings: ' + e.message)
  } finally {
    saving.value = false
  }
}

async function performMigration() {
  saving.value = true
  migrationPrompt.show = false

  try {
    const result = await api.updateDataDir(dataDir.value.trim(), true)
    
    migrationStatus.value = {
      show: true,
      success: result.success || false,
      message: result.message || (result.success ? 'Migration completed successfully' : 'Migration failed'),
      details: result.migration || null,
      files_copied: result.migration?.files_copied,
      directories_copied: result.migration?.directories_copied,
    }

    if (result.success) {
      await loadSettings()
      // Reload page after a moment to ensure everything is updated
      setTimeout(() => {
        window.location.reload()
      }, 2000)
    }
  } catch (e) {
    migrationStatus.value = {
      show: true,
      success: false,
      message: 'Migration failed: ' + e.message,
      details: null,
    }
  } finally {
    saving.value = false
  }
}

function cancelMigration() {
  migrationPrompt.show = false
  dataDir.value = currentSettings.value.data_dir || ''
}

function resetForm() {
  dataDir.value = currentSettings.value.data_dir || ''
  migrationPrompt.show = false
  migrationStatus.show = false
}

function browseDirectory() {
  // Note: Browser security prevents direct file system access
  // This would need a native file picker or Electron integration
  alert('Directory browsing requires a native file picker. Please enter the path manually.')
}

function triggerCookiesUpload() {
  cookiesFileInput.value?.click()
}

async function handleCookiesFileSelect(event) {
  const file = event.target.files?.[0]
  if (!file) return

  savingCookies.value = true
  cookiesStatus.value.show = false

  try {
    const result = await api.uploadYtdlpCookies(file)
    cookiesStatus.value = {
      show: true,
      success: true,
      message: result.message,
    }
    await loadSettings()
  } catch (e) {
    cookiesStatus.value = {
      show: true,
      success: false,
      message: e.message,
    }
  } finally {
    savingCookies.value = false
    // Reset file input so same file can be selected again
    event.target.value = ''
  }
}

async function deleteCookiesFile() {
  savingCookies.value = true
  cookiesStatus.value.show = false

  try {
    const result = await api.deleteYtdlpCookies()
    cookiesStatus.value = {
      show: true,
      success: true,
      message: result.message,
    }
    await loadSettings()
  } catch (e) {
    cookiesStatus.value = {
      show: true,
      success: false,
      message: e.message,
    }
  } finally {
    savingCookies.value = false
  }
}

async function refreshYtdlpStatus() {
  try {
    const result = await api.getYtdlpStatus()
    ytdlpStatus.value = result || {}
    ytdlpSettings.value = {
      updatePolicy: result.updatePolicy || 'manual',
      pinnedVersion: result.pinnedVersion || '',
    }
    ytdlpBusy.value = ['queued', 'running'].includes(result.job?.status)
    if (ytdlpBusy.value) startYtdlpPolling()
  } catch (e) {
    ytdlpMessage.value = {
      show: true,
      success: false,
      message: 'Failed to load yt-dlp status: ' + e.message,
    }
  }
}

async function saveYtdlpSettings() {
  ytdlpMessage.value.show = false
  try {
    ytdlpSettings.value = await api.updateYtdlpSettings(ytdlpSettings.value)
    ytdlpMessage.value = {
      show: true,
      success: true,
      message: 'yt-dlp settings saved.',
    }
  } catch (e) {
    ytdlpMessage.value = {
      show: true,
      success: false,
      message: 'Failed to save yt-dlp settings: ' + e.message,
    }
  }
}

async function startYtdlpUpdate(target) {
  const cleanTarget = target === 'latest' ? 'latest' : String(target || '').trim()
  if (!cleanTarget) return
  ytdlpBusy.value = true
  ytdlpMessage.value = {
    show: true,
    success: true,
    message: cleanTarget === 'latest' ? 'Started yt-dlp update to latest.' : `Started yt-dlp install for ${cleanTarget}.`,
  }
  try {
    ytdlpStatus.value = {
      ...ytdlpStatus.value,
      job: await api.updateYtdlp(cleanTarget),
    }
    startYtdlpPolling()
  } catch (e) {
    ytdlpBusy.value = false
    ytdlpMessage.value = {
      show: true,
      success: false,
      message: 'Failed to start yt-dlp update: ' + e.message,
    }
  }
}

function startYtdlpPolling() {
  if (ytdlpPollTimer) clearInterval(ytdlpPollTimer)
  ytdlpPollTimer = setInterval(async () => {
    try {
      const result = await api.getYtdlpStatus()
      ytdlpStatus.value = result || {}
      ytdlpBusy.value = ['queued', 'running'].includes(result.job?.status)
      if (!ytdlpBusy.value) {
        clearInterval(ytdlpPollTimer)
        ytdlpPollTimer = null
        ytdlpMessage.value = {
          show: true,
          success: result.job?.status === 'completed',
          message: result.job?.status === 'completed'
            ? `yt-dlp is now ${result.version || 'updated'}. Restart the backend if a downloader was already mid-run.`
            : `yt-dlp update failed: ${result.job?.error || (result.job?.output ? 'open pip output for details' : 'no error details were captured')}`,
        }
      }
    } catch (e) {
      clearInterval(ytdlpPollTimer)
      ytdlpPollTimer = null
      ytdlpBusy.value = false
      ytdlpMessage.value = {
        show: true,
        success: false,
        message: 'Failed to poll yt-dlp update: ' + e.message,
      }
    }
  }, 1200)
}
</script>

<style scoped>
.settings-view {
  max-width: 900px;
  margin: 0 auto;
}

.settings-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.settings-section h2 {
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}

.section-description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-bottom: 1.5rem;
}

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

.migration-prompt {
  margin: 1.5rem 0;
}

.alert {
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
}

.alert-warning {
  background: var(--warning);
  border-color: var(--border);
  color: var(--text-primary);
}

.migration-info {
  margin: 1rem 0;
  padding: 0.75rem;
  background: var(--bg-secondary);
  border-radius: 0.5rem;
}

.migration-info p {
  margin: 0.5rem 0;
  font-size: 0.9rem;
}

.migration-info code {
  background: var(--bg-primary);
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.85rem;
  word-break: break-all;
}

.migration-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.migration-status {
  margin: 1rem 0;
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
}

.migration-status.success {
  background: var(--success-soft);
  border-color: var(--success);
  color: var(--text-primary);
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

.update-panel {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--bg-secondary);
}

.update-summary {
  margin-top: 1rem;
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

.migration-details {
  margin-top: 0.5rem;
  font-size: 0.9rem;
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

.runtime-details {
  margin-top: 1rem;
}

.runtime-details summary {
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 600;
  margin-bottom: 0.75rem;
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

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
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

.config-panel {
  padding: 1rem;
  margin-top: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
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

.ai-master-toggle {
  max-width: 520px;
  margin-bottom: 1rem;
}

.ai-config-body {
  display: contents;
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

.model-toggle-list {
  display: grid;
  gap: 0.5rem;
}

.model-toggle-row {
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
}

.model-toggle-row em {
  justify-self: end;
  padding: 0.22rem 0.5rem;
  border-radius: 0.35rem;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-style: normal;
  white-space: nowrap;
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

.label-with-help {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
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

.field-row input,
.field-row select,
.field-row textarea {
  width: 100%;
}

.cors-field {
  margin-top: 0.75rem;
}

.cors-field textarea {
  min-height: 76px;
  resize: vertical;
  font-family: 'Courier New', monospace;
  font-size: 0.84rem;
}

.runtime-card {
  display: grid;
  gap: 0.35rem;
  align-self: end;
  min-height: 72px;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.runtime-card strong {
  color: var(--text-primary);
}

.runtime-card small {
  color: var(--text-secondary);
  line-height: 1.4;
}

.bulk-toolbar {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  gap: 1rem;
  align-items: end;
}

.bulk-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(160px, 1fr));
  gap: 0.75rem;
  align-items: stretch;
}

.bulk-action-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-content: flex-start;
  min-width: 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.bulk-action-group > span {
  flex: 0 0 100%;
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1.2;
  text-transform: uppercase;
}

.bulk-action-group .btn {
  flex: 1 1 120px;
  min-width: 0;
}

.bulk-action-group.danger-zone {
  border-color: rgba(248, 113, 113, 0.35);
}

.action-tooltip {
  position: relative;
}

.action-tooltip::after {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 30;
  display: block;
  width: max-content;
  max-width: min(360px, 72vw);
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
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.action-tooltip:hover::after,
.action-tooltip:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

.bulk-defaults-note {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  align-items: center;
  margin-top: 0.85rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 0.83rem;
  line-height: 1.45;
}

.bulk-defaults-note strong {
  color: var(--text-primary);
}

.estimate-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(5, 8, 13, 0.72);
  backdrop-filter: blur(4px);
}

.preview-modal {
  width: min(920px, calc(100vw - 2rem));
  max-height: min(760px, calc(100vh - 2rem));
  overflow: auto;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-secondary);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.42);
}

.modal-head {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.modal-head h2 {
  margin: 0 0 0.25rem;
}

.modal-head p {
  margin: 0;
  color: var(--text-secondary);
}

.empty-preview {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
}

.preview-list {
  display: grid;
  gap: 0.75rem;
}

.preview-row {
  display: grid;
  gap: 0.65rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.preview-row-head {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
}

.preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.preview-tags span,
.preview-tags em {
  padding: 0.25rem 0.45rem;
  border: 1px solid var(--accent);
  border-radius: 0.35rem;
  background: rgba(96, 165, 250, 0.12);
  color: var(--accent);
  font-size: 0.78rem;
  font-style: normal;
  line-height: 1.2;
}

.preview-row p {
  margin: 0;
  color: var(--text-secondary);
}

.estimate-strip strong {
  color: var(--text-primary);
}

.model-row {
  padding: 1rem;
  background: linear-gradient(180deg, var(--bg-secondary), var(--bg-primary));
  border: 1px solid var(--border);
  border-radius: 0.5rem;
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

.semantic-prompt-panel textarea {
  width: 100%;
  min-height: 150px;
  resize: vertical;
  font-family: inherit;
  font-size: 0.84rem;
  line-height: 1.45;
}

.btn-small {
  padding: 0.4rem 0.65rem;
  font-size: 0.8rem;
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

.stat-card {
  background: var(--bg-secondary);
  border-radius: 0.75rem;
  padding: 1.25rem;
  text-align: center;
  transition: transform 0.2s, box-shadow 0.2s;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.stat-card.wide {
  grid-column: span 2;
}

.stat-value {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 0.25rem;
}

.stat-label {
  font-size: 0.85rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

@media (max-width: 768px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .stat-card.wide {
    grid-column: span 1;
  }

  .config-panel-head,
  .pipeline-head {
    flex-direction: column;
  }

  .config-panel-head p,
  .pipeline-models {
    max-width: none;
    text-align: left;
  }

  .model-toggle-row {
    grid-template-columns: 18px minmax(0, 1fr);
  }

  .model-toggle-row em {
    grid-column: 2;
    justify-self: start;
  }

  .bulk-toolbar {
    grid-template-columns: 1fr;
  }

  .bulk-actions {
    grid-template-columns: 1fr;
  }

  .bulk-action-group .btn {
    flex: 1 1 140px;
  }

  .ytdlp-status-grid,
  .ytdlp-controls {
    grid-template-columns: 1fr;
  }

  .modal-head {
    flex-direction: column;
  }
}
</style>
