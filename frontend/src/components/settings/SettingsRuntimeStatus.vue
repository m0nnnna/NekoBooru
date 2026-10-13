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

.model-ok {
  color: var(--success);
  font-weight: 600;
}

.model-missing {
  color: var(--text-secondary);
}
</style>
