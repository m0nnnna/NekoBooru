const API_BASE = '/api'

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
      throw new Error('Backend server is not running. Please start the backend server on port 8000.')
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

  async updatePost(id, data) {
    return request(`/posts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deletePost(id) {
    return request(`/posts/${id}`, { method: 'DELETE' })
  },

  async toggleFavorite(id) {
    return request(`/posts/${id}/favorite`, { method: 'POST' })
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

  async createPost(data) {
    return request('/posts', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  // Tags
  async getTags(params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/tags${query ? `?${query}` : ''}`)
  },

  async autocomplete(q) {
    return request(`/tags/autocomplete?q=${encodeURIComponent(q)}`)
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

  async migrateData(dataDir) {
    return request('/settings/migrate', {
      method: 'POST',
      body: JSON.stringify({ data_dir: dataDir, migrate: true }),
    })
  },

  async updateYtdlpCookies(cookiesPath) {
    return request('/settings/ytdlp-cookies', {
      method: 'PUT',
      body: JSON.stringify({ cookies_path: cookiesPath }),
    })
  },
}

export default api
