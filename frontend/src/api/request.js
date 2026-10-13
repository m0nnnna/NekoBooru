// The one fetch wrapper every API module uses.
export const API_BASE = '/api'
export const BACKEND_LABEL = import.meta.env.VITE_BACKEND || 'the configured backend'

/**
 * What every failed request() throws.
 *   kind          'http' (the server answered non-2xx), 'network' (no answer:
 *                 backend down, connection refused, CORS) or 'aborted' (the
 *                 caller's signal fired; `name` stays 'AbortError' for the
 *                 callers that check that)
 *   status        the HTTP status, null unless kind is 'http'
 *   detail        the body's `detail` (a string or the relays' { code, message, retryAfter })
 *   retryAfterMs  the Retry-After header (delta seconds), else detail.retryAfter; null when neither
 */
export class ApiError extends Error {
  constructor(message, { kind, status = null, detail = null, retryAfterMs = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = kind === 'aborted' ? 'AbortError' : 'ApiError'
    this.kind = kind
    this.status = status
    this.detail = detail
    this.retryAfterMs = retryAfterMs
  }
}

function secondsToMs(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  return Math.round(Number(text) * 1000)
}

// Only the delta-seconds form of Retry-After, as the backend sends it.
function retryAfterMsFrom(response, detail) {
  const header = typeof response.headers?.get === 'function' ? response.headers.get('Retry-After') : null
  const fromHeader = secondsToMs(header)
  if (fromHeader !== null) return fromHeader
  return detail && typeof detail === 'object' ? secondsToMs(detail.retryAfter) : null
}

function transportError(error) {
  if (error?.name === 'AbortError') {
    return new ApiError(error.message || 'The request was aborted', { kind: 'aborted', cause: error })
  }
  // fetch() rejects with a TypeError for every failure to get an answer, and
  // each browser words it differently ("Failed to fetch", "Load failed", ...).
  if (error instanceof TypeError) {
    return new ApiError(`Backend server is not running. Please start ${BACKEND_LABEL}.`, { kind: 'network', cause: error })
  }
  return error
}

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

  let response
  try {
    response = await fetch(url, config)
  } catch (error) {
    throw transportError(error)
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: 'Request failed' }))
    const detail = body?.detail ?? null
    const message = typeof detail === 'object' && detail !== null
      ? detail.message || detail.code
      : detail
    // Let a single listener (see main.js) clear auth state and redirect to
    // /login, instead of every call site checking response.status itself.
    // The auth endpoints handle their own 401s (wrong password, expired
    // bootstrap window) inline, so they opt out of the global redirect.
    if (response.status === 401 && !endpoint.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('neko:unauthorized'))
    }
    throw new ApiError(message || `HTTP ${response.status}`, {
      kind: 'http',
      status: response.status,
      detail,
      retryAfterMs: retryAfterMsFrom(response, detail),
    })
  }

  try {
    return await response.json()
  } catch (error) {
    // An abort can also land while the body is still streaming.
    if (error?.name === 'AbortError') throw transportError(error)
    throw error
  }
}
