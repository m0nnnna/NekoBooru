import { request } from './request.js'

// Posts, their AI analyses, pools, notes, comments and stats.
export const postsApi = {
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

  async getPostOnlineMatches(id) {
    return request(`/posts/${id}/online-matches`)
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
  async getStats(userId) {
    return request(userId ? `/settings/stats?userId=${userId}` : '/settings/stats')
  },

  async getDashboard(userId) {
    return request(userId ? `/settings/dashboard?userId=${userId}` : '/settings/dashboard')
  },

  async restorePost(id) { return request(`/posts/${id}/restore`, { method: 'POST' }) },
}
