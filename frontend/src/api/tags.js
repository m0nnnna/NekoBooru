import { request } from './request.js'

// Tags, implications and aliases.
export const tagsApi = {
  // Tags
  async getTags(params = {}) {
    const query = new URLSearchParams(params).toString()
    return request(`/tags${query ? `?${query}` : ''}`)
  },

  async autocomplete(q, options = {}) {
    const params = new URLSearchParams({ q })
    if (options.nameParts) params.set('nameParts', 'true')
    // Tags this library does not have yet, from public boorus. The server
    // ignores it unless booru suggestions are enabled in settings.
    if (options.includeRemote) params.set('includeRemote', 'true')
    // Ask the boorus even with that setting off, for a field whose purpose is
    // finding the booru's name for a tag.
    if (options.forceRemote) params.set('forceRemote', 'true')
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

  // Sankaku's name for a tag, looked up on the backend the first time it is needed.
  async resolveSankakuName(name) {
    return request(`/tags/${encodeURIComponent(name)}/sankaku-name`, { method: 'POST' })
  },

  // e621's name for a tag (yui_hirasawa for hirasawa_yui), same contract.
  async resolveE621Name(name) {
    return request(`/tags/${encodeURIComponent(name)}/e621-name`, { method: 'POST' })
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
}
