import { request } from './request.js'

// AI auto-tagging: settings, models, credentials and bulk jobs.
export const autoTagsApi = {
  // Auto tags
  async getAutoTagSettings() {
    return request('/auto-tags/settings')
  },

  async updateAutoTagSettings(settings) {
    return request('/auto-tags/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    })
  },

  async getAutoTagStatus() {
    return request('/auto-tags/status')
  },

  async downloadAutoTagModel() {
    return request('/auto-tags/model/download', { method: 'POST' })
  },

  async getAutoTagModels() {
    return request('/auto-tags/models')
  },

  async downloadAutoTagModelById(id) {
    return request(`/auto-tags/models/${encodeURIComponent(id)}/download`, { method: 'POST' })
  },

  async downloadAllAutoTagModels() {
    return request('/auto-tags/models/download-all', { method: 'POST' })
  },

  async getAutoTagModelDownloadJob() {
    return request('/auto-tags/models/download-job')
  },

  async cancelAutoTagModelDownloadJob() {
    return request('/auto-tags/models/download-job/cancel', { method: 'POST' })
  },

  async loadAutoTagModelById(id) {
    return request(`/auto-tags/models/${encodeURIComponent(id)}/load`, { method: 'POST' })
  },

  async unloadAutoTagModelById(id) {
    return request(`/auto-tags/models/${encodeURIComponent(id)}/unload`, { method: 'POST' })
  },

  async deleteAutoTagModelById(id) {
    return request(`/auto-tags/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  async getAutoTagModelLoadJob() {
    return request('/auto-tags/models/load-job')
  },

  async saveHuggingFaceToken(token) {
    return request('/auto-tags/huggingface-token', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    })
  },

  async deleteHuggingFaceToken() {
    return request('/auto-tags/huggingface-token', { method: 'DELETE' })
  },

  async saveGelbooruCredentials(userId, apiKey) {
    return request('/auto-tags/gelbooru-credentials', {
      method: 'PUT',
      body: JSON.stringify({ userId, apiKey }),
    })
  },

  async deleteGelbooruCredentials() {
    return request('/auto-tags/gelbooru-credentials', { method: 'DELETE' })
  },

  async saveTaggerWorkerToken(token) {
    return request('/auto-tags/worker-token', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    })
  },

  async deleteTaggerWorkerToken() {
    return request('/auto-tags/worker-token', { method: 'DELETE' })
  },

  async estimateAutoTagJob(mode = 'lightly_tagged') {
    return request(`/auto-tags/estimate?mode=${encodeURIComponent(mode)}`)
  },

  async createAutoTagJob(data) {
    return request('/auto-tags/jobs', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async getCurrentAutoTagJob() {
    return request('/auto-tags/jobs/current')
  },

  async getAutoTagJob(id) {
    return request(`/auto-tags/jobs/${id}`)
  },

  async getAutoTagJobSuggestions(id, params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/auto-tags/jobs/${id}/suggestions${query ? `?${query}` : ''}`)
  },

  async cancelAutoTagJob(id) {
    return request(`/auto-tags/jobs/${id}/cancel`, { method: 'POST' })
  },

  async applyAutoTagJob(id) {
    return request(`/auto-tags/jobs/${id}/apply`, { method: 'POST' })
  },
}
