// Per-site request budget for the browser side of booru search: a token
// bucket plus a cooldown, the JS twin of _RequestBudget/_cooldowns in
// backend/app/services/booru_suggest.py. Unlike the suggestion budget, a
// search that cannot take() is deferred by the caller for retryInMs(), never
// dropped (section 3.4 of docs/booru-search-plan.md).

// Applied when a booru answers 429/503 without saying how long to wait.
export const DEFAULT_COOLDOWN_SECONDS = 60
export const MAX_COOLDOWN_SECONDS = 900
// Refill arithmetic is floating point; 0.999 + 0.001 must still buy a request.
const EPSILON = 1e-9

// Seconds from a Retry-After header value (a Headers object, a Response, or
// the raw string). Only the delta form is honoured, as on the backend; the
// HTTP-date form and anything unreadable give null (-> the default cooldown).
export function retryAfterSeconds(source) {
  let raw = source
  if (source && typeof source === 'object') {
    const headers = source.headers && typeof source.headers.get === 'function' ? source.headers : source
    raw = typeof headers.get === 'function' ? headers.get('Retry-After') : null
  }
  const text = String(raw ?? '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  return Number(text)
}

/**
 * createBudget({ burst = 6, perSecond = 1 })
 *   -> { take(): boolean, retryInMs(): number, coolDown(seconds), coolingDown(): boolean, reset() }
 *
 * `now` (ms clock) is injectable for tests; it defaults to Date.now, which
 * vitest's fake timers also drive.
 */
export function createBudget({ burst = 6, perSecond = 1, now = () => Date.now() } = {}) {
  const capacity = Math.max(1, Number(burst) || 1)
  const rate = Math.max(0.001, Number(perSecond) || 1)
  let tokens = capacity
  let updated = now()
  let coolUntil = 0

  function refill() {
    const at = now()
    tokens = Math.min(capacity, tokens + Math.max(0, at - updated) / 1000 * rate)
    updated = at
    return at
  }

  function coolingDown() {
    if (!coolUntil) return false
    if (now() >= coolUntil) {
      coolUntil = 0
      return false
    }
    return true
  }

  return {
    take() {
      refill()
      if (coolingDown() || tokens < 1 - EPSILON) return false
      tokens = Math.max(0, tokens - 1)
      return true
    },

    // Milliseconds until take() can succeed; 0 when it can now.
    retryInMs() {
      const at = refill()
      const cooldown = coolingDown() ? coolUntil - at : 0
      const refillWait = tokens >= 1 - EPSILON ? 0 : Math.ceil((1 - tokens) / rate * 1000)
      return Math.max(cooldown, refillWait)
    },

    // Back off for `seconds` (a Retry-After value), DEFAULT_COOLDOWN_SECONDS
    // when missing, clamped to 1..MAX_COOLDOWN_SECONDS. Never shortens a
    // cooldown that is already running.
    coolDown(seconds) {
      const parsed = Number(seconds)
      const wait = Math.max(1, Math.min(parsed > 0 ? parsed : DEFAULT_COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS))
      coolUntil = Math.max(coolUntil, now() + wait * 1000)
    },

    coolingDown,

    reset() {
      tokens = capacity
      updated = now()
      coolUntil = 0
    },
  }
}
