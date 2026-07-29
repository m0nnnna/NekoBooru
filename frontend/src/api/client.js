const API_BASE = '/api'
const BACKEND_LABEL = import.meta.env.VITE_BACKEND || 'the configured backend'

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }

  // Don't set Content-Type for FormData
  if (options.body instanceof FormData) {
    delete config.headers['Content-Type']
  }

  try {
    const response = await fetch(url, config)

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Request failed' }))
      throw new Error(error.detail || `HTTP ${response.status}`)
    }

    return response.json()
  } catch (error) {
    // Handle network errors (backend not running, connection refused, etc.)
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error(`Backend server is not running. Please start ${BACKEND_LABEL}.`)
    }
    throw error
  }
}

export const api = {
  // Posts
  async getPosts(params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/posts${query ? `?${query}` : ''}`)
  },

  async getPost(id) {
    return request(`/posts/${id}`)
  },

  async getPostNeighbors(id, params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/posts/${id}/neighbors${query ? `?${query}` : ''}`)
  },

  async getSimilarPosts(id, params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/posts/${id}/similar${query ? `?${query}` : ''}`)
  },

  async getDuplicateGroups() {
    return request('/posts/duplicates')
  },

  async getSimilarityBackfill() {
    return request('/posts/similarity/backfill')
  },

  async startSimilarityBackfill() {
    return request('/posts/similarity/backfill', { method: 'POST' })
  },

  async updatePost(id, data) {
    return request(`/posts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deletePost(id) {
    return request(`/posts/${id}`, { method: 'DELETE' })
  },

  async bulkDeletePosts(postIds) {
    return request('/posts/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ postIds }),
    })
  },

  async bulkUpdatePosts(data) {
    return request('/posts/bulk-update', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async bulkOptimizePosts(data) {
    return request('/posts/bulk-optimize', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async createOptimizeJob(data) {
    return request('/posts/optimize-jobs', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async getOptimizeJob(id) {
    return request(`/posts/optimize-jobs/${id}`)
  },

  async toggleFavorite(id) {
    return request(`/posts/${id}/favorite`, { method: 'POST' })
  },

  async previewAutoTags(id, data = {}) {
    return request(`/posts/${id}/auto-tags/preview`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async applyAutoTags(id, data = {}) {
    return request(`/posts/${id}/auto-tags/apply`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async getPostAiAnalysis(id) {
    return request(`/posts/${id}/ai-analysis`)
  },

  async savePostAiAnalysis(id, data = {}) {
    return request(`/posts/${id}/ai-analysis`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updatePostAiAnalysis(postId, analysisId, data = {}) {
    return request(`/posts/${postId}/ai-analysis/${analysisId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deletePostAiAnalysis(id) {
    return request(`/posts/${id}/ai-analysis`, { method: 'DELETE' })
  },

  // Uploads
  async uploadFile(file) {
    const formData = new FormData()
    formData.append('content', file)
    return request('/uploads', {
      method: 'POST',
      body: formData,
    })
  },

  async uploadFromUrl(url) {
    return request('/uploads/from-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
  },

  async uploadFromYtdlp(url) {
    return request('/uploads/from-ytdlp', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
  },

  async uploadFromFediverse(url) {
    return request('/uploads/from-fediverse', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
  },

  async previewUploadAutoTags(token, data = {}) {
    return request(`/uploads/${encodeURIComponent(token)}/auto-tags/preview`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async createPost(data) {
    return request('/posts', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

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

  // Tags
  async getTags(params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/tags${query ? `?${query}` : ''}`)
  },

  async autocomplete(q, options = {}) {
    const params = new URLSearchParams({ q })
    if (options.nameParts) params.set('nameParts', 'true')
    return request(`/tags/autocomplete?${params.toString()}`)
  },

  async getTag(name) {
    return request(`/tags/${encodeURIComponent(name)}`)
  },

  async createTag(data) {
    return request('/tags', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateTag(name, data) {
    return request(`/tags/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deleteTag(name) {
    return request(`/tags/${encodeURIComponent(name)}`, { method: 'DELETE' })
  },

  async getCategories() {
    return request('/tag-categories')
  },

  // Implications
  async getImplications(params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/tag-implications${query ? `?${query}` : ''}`)
  },

  async createImplication(data) {
    return request('/tag-implications', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async deleteImplication(id) {
    return request(`/tag-implications/${id}`, { method: 'DELETE' })
  },

  // Aliases
  async getAliases(params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/tag-aliases${query ? `?${query}` : ''}`)
  },

  async createAlias(data) {
    return request('/tag-aliases', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async deleteAlias(id) {
    return request(`/tag-aliases/${id}`, { method: 'DELETE' })
  },

  // Pools
  async getPools(params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/pools${query ? `?${query}` : ''}`)
  },

  async getPool(id) {
    return request(`/pools/${id}`)
  },

  async createPool(data) {
    return request('/pools', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updatePool(id, data) {
    return request(`/pools/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deletePool(id) {
    return request(`/pools/${id}`, { method: 'DELETE' })
  },

  async addPostsToPool(poolId, postIds) {
    return request(`/pools/${poolId}/posts`, {
      method: 'POST',
      body: JSON.stringify({ postIds }),
    })
  },

  async removePostFromPool(poolId, postId) {
    return request(`/pools/${poolId}/posts/${postId}`, { method: 'DELETE' })
  },

  // Notes
  async getNotes(postId) {
    return request(`/posts/${postId}/notes`)
  },

  async createNote(postId, data) {
    return request(`/posts/${postId}/notes`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateNote(id, data) {
    return request(`/notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deleteNote(id) {
    return request(`/notes/${id}`, { method: 'DELETE' })
  },

  // Comments
  async getComments(postId) {
    return request(`/posts/${postId}/comments`)
  },

  async createComment(postId, text) {
    return request(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  },

  async updateComment(id, text) {
    return request(`/comments/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ text }),
    })
  },

  async deleteComment(id) {
    return request(`/comments/${id}`, { method: 'DELETE' })
  },

  // Stats
  async getStats() {
    return request('/settings/stats')
  },

  async getDashboard() {
    return request('/settings/dashboard')
  },

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
}

export default api
