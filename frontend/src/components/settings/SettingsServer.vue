<template>
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
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsServer().
  server: {
    type: Object,
    required: true,
  },
})

const {
  currentSettings,
  serverSettings,
  savingServer,
  serverStatus,
  serverHelp,
  saveServerSettings,
} = props.server
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

.status-note {
  margin: 0.75rem 0 0;
  color: var(--text-secondary);
  font-size: 0.85rem;
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
</style>
