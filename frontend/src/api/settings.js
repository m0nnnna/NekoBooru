import { request } from './request.js'

// Server, extension, yt-dlp, runtime and update settings, and the health check.
export const settingsApi = {
  // Health check
  async checkHealth() {
    return request('/health')
  },

  // Settings
  async getSettings() {
    return request('/settings')
  },

  async updateDataDir(dataDir, migrate = false) {
    return request('/settings/data-dir', {
      method: 'PUT',
      body: JSON.stringify({ data_dir: dataDir, migrate }),
    })
  },

  async updateServerSettings(data) {
    return request('/settings/server', {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async getExtensionSettings() {
    return request('/settings/extension')
  },

  async updateExtensionSettings(data) {
    return request('/settings/extension', {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async getAiModelDefaults() {
    return request('/settings/ai-model-defaults')
  },

  async updateAiModelDefaults(modelDefaults) {
    return request('/settings/ai-model-defaults', {
      method: 'PUT',
      body: JSON.stringify({ modelDefaults }),
    })
  },

  async migrateData(dataDir) {
    return request('/settings/migrate', {
      method: 'POST',
      body: JSON.stringify({ data_dir: dataDir, migrate: true }),
    })
  },

  async uploadYtdlpCookies(file) {
    const formData = new FormData()
    formData.append('file', file)
    return request('/settings/ytdlp-cookies', {
      method: 'POST',
      body: formData,
    })
  },

  async deleteYtdlpCookies() {
    return request('/settings/ytdlp-cookies', {
      method: 'DELETE',
    })
  },

  async getYtdlpStatus() {
    return request('/settings/ytdlp')
  },

  async updateYtdlpSettings(data) {
    return request('/settings/ytdlp', {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async updateYtdlp(target = 'latest') {
    return request('/settings/ytdlp/update', {
      method: 'POST',
      body: JSON.stringify({ target }),
    })
  },

  // Runtime / packaging
  async getRuntimeStatus() {
    return request('/runtime/status')
  },

  async getAiRuntimeProfiles() {
    return request('/runtime/ai/profiles')
  },

  async installAiRuntime(profile = 'auto', force = false) {
    return request('/runtime/ai/install', {
      method: 'POST',
      body: JSON.stringify({ profile, force }),
    })
  },

  async getAiRuntimeInstallJob() {
    return request('/runtime/ai/install-job')
  },

  async cancelAiRuntimeInstall() {
    return request('/runtime/ai/cancel-install', { method: 'POST' })
  },

  async restartApp() {
    return request('/runtime/restart', { method: 'POST' })
  },

  // App updates
  async getUpdateStatus(auto = false) {
    return request(`/updates/status${auto ? '?auto=true' : ''}`)
  },

  async updateUpdateSettings(data) {
    return request('/updates/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async checkForUpdates() {
    return request('/updates/check', { method: 'POST' })
  },

  // Admin switch (section 2.2)
  async getBooruSearchSettings() { return request('/settings/booru-search') },
  async updateBooruSearchSettings(enabled) { return request('/settings/booru-search', { method: 'PUT', body: JSON.stringify({ enabled }) }) },
}
