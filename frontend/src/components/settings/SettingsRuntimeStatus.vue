<template>
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
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsRuntime().
  runtime: {
    type: Object,
    required: true,
  },
})

const { runtimeStatus, runtimeAiSummary, runtimeToolSummary, loadRuntimeStatus } = props.runtime
</script>
<style scoped>
.runtime-details {
  margin-top: 1rem;
}

.runtime-details summary {
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 600;
  margin-bottom: 0.75rem;
}
</style>
