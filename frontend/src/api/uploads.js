import { API_BASE, BACKEND_LABEL, request } from './request.js'

// Uploads, upload jobs, post creation and server-side URL fetches.
export const uploadsApi = {
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

  async createUploadJob(data, idempotencyKey = null) {
    return request('/upload-jobs', {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      body: JSON.stringify(data),
    })
  },

  async getUploadJob(id) {
    return request(`/upload-jobs/${encodeURIComponent(id)}`)
  },

  uploadJobContent(id, file, onProgress = null) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `${API_BASE}/upload-jobs/${encodeURIComponent(id)}/content`)
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
      xhr.upload.onprogress = event => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total)
      }
      xhr.onerror = () => reject(new Error(`Backend server is not running. Please start ${BACKEND_LABEL}.`))
      xhr.onload = () => {
        let payload = null
        try { payload = JSON.parse(xhr.responseText || '{}') } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload)
          return
        }
        const detail = payload?.detail
        reject(new Error((typeof detail === 'object' ? detail?.message : detail) || `HTTP ${xhr.status}`))
      }
      xhr.send(file)
    })
  },

  async sampleUploadJob(id, data) {
    return request(`/upload-jobs/${encodeURIComponent(id)}/sample`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async renderUploadJob(id, data) {
    return request(`/upload-jobs/${encodeURIComponent(id)}/render`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async publishUploadJob(id, data, idempotencyKey = null) {
    return request(`/upload-jobs/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      body: JSON.stringify(data),
    })
  },

  async cancelUploadJob(id) {
    return request(`/upload-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  },

  async retryUploadJob(id) {
    return request(`/upload-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' })
  },

  async deleteUploadJob(id) {
    const response = await fetch(`${API_BASE}/upload-jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`)
    return null
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

  async fetchFromUrl({ url, referer, progressId }) { return request('/uploads/from-url', { method: 'POST', body: JSON.stringify({ url, referer, progressId }) }) },
  async getFromUrlProgress(progressId) { return request(`/uploads/from-url/progress/${encodeURIComponent(progressId)}`) },
}
