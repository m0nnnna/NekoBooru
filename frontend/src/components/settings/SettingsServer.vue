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
