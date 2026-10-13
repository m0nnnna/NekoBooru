// The one fetch wrapper every API module uses.
export const API_BASE = '/api'
export const BACKEND_LABEL = import.meta.env.VITE_BACKEND || 'the configured backend'

export async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`
  const config = {
    ...options,
    // Send the httpOnly session cookie even when the frontend dev server
    // (:5173) proxies to the backend (:8772) as a different origin.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  }

  // Don't set Content-Type for FormData
  if (options.body instanceof FormData) {
    delete config.headers['Content-Type']
  }

  try {
    const response = await fetch(url, config)

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Request failed' }))
      const detail = error.detail
      const message = typeof detail === 'object' && detail !== null
        ? detail.message || detail.code
        : detail
      const thrown = new Error(message || `HTTP ${response.status}`)
      thrown.detail = detail
      thrown.status = response.status
      // Let a single listener (see main.js) clear auth state and redirect to
      // /login, instead of every call site checking response.status itself.
      // The auth endpoints handle their own 401s (wrong password, expired
      // bootstrap window) inline, so they opt out of the global redirect.
      if (response.status === 401 && !endpoint.startsWith('/auth/')) {
        window.dispatchEvent(new CustomEvent('neko:unauthorized'))
      }
      throw thrown
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
