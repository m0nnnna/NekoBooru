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
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import api from '../api/client'

const currentSettings = ref({})
const dataDir = ref('')
const saving = ref(false)
const isWindows = ref(navigator.platform.toLowerCase().includes('win'))

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
  await loadSettings()
})

async function loadSettings() {
  try {
    currentSettings.value = await api.getSettings()
    dataDir.value = currentSettings.value.data_dir || ''
  } catch (e) {
    alert('Failed to load settings: ' + e.message)
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

.migration-status.error {
  background: var(--coral-soft);
  border-color: var(--coral);
  color: var(--text-primary);
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
</style>
