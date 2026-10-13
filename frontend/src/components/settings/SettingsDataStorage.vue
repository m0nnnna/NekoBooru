<template>
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
  dataDir,
  saving,
  isWindows,
  migrationPrompt,
  migrationStatus,
  saveSettings,
  performMigration,
  cancelMigration,
  resetForm,
  browseDirectory,
} = props.server
</script>
<style scoped>
.help-text code {
  background: var(--bg-secondary);
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.8rem;
}

.alert {
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
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

.migration-details {
  margin-top: 0.5rem;
  font-size: 0.9rem;
}
</style>
