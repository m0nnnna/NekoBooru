import { request } from './request.js'

// Sessions, users, shares and API tokens.
export const authApi = {
  // Auth
  async getAuthStatus() {
    return request('/auth/status')
  },

  async bootstrapAdmin(username, password) {
    return request('/auth/bootstrap-admin', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  },

  async login(username, password) {
    return request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  },

  async logout() {
    return request('/auth/logout', { method: 'POST' })
  },

  async getMe() {
    return request('/auth/me')
  },

  async getUsers() {
    return request('/auth/users')
  },

  async getDirectory() {
    return request('/auth/directory')
  },

  async createUser(data) {
    return request('/auth/users', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateUser(id, data) {
    return request(`/auth/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async getShares() { return request('/auth/shares') },
  async setShares(granteeUsernames) { return request('/auth/shares', { method: 'PUT', body: JSON.stringify({ granteeUsernames }) }) },

  async getApiTokens() { return request('/auth/tokens') },
  async createApiToken(label) { return request('/auth/tokens', { method: 'POST', body: JSON.stringify({ label }) }) },
  async deleteApiToken(id) { return request(`/auth/tokens/${id}`, { method: 'DELETE' }) },
}
