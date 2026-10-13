// Data storage (data directory and migration) and the server bind settings.
import { ref } from 'vue'
import api from '../api/client'

export function useSettingsServer() {
  const currentSettings = ref({})
  const dataDir = ref('')
  const saving = ref(false)
  const isWindows = ref(navigator.platform.toLowerCase().includes('win'))
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
  const serverHelp = {
    host: '127.0.0.1 keeps NekoBooru available only on this PC. Use 0.0.0.0 only if you intentionally want LAN devices to reach it; NekoBooru has no built-in user login.',
    port: 'The TCP port for the backend and packaged web UI. Change it if another app already uses 8772. Restart required.',
    frontendPort: 'Dev/source mode only. Packaged installs serve the frontend from the backend port. Restart the Vite frontend dev server after changing this.',
    cors: 'Comma-separated browser origins allowed to call the API. Keep localhost/127.0.0.1 entries for the active port. Only add LAN origins you trust.',
  }

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
  return {
    currentSettings,
    dataDir,
    saving,
    isWindows,
    serverSettings,
    savingServer,
    serverStatus,
    serverHelp,
    migrationPrompt,
    migrationStatus,
    loadSettings,
    saveServerSettings,
    saveSettings,
    performMigration,
    cancelMigration,
    resetForm,
    browseDirectory,
  }
}
