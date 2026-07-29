export function parseTimecode(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parts = raw.split(':')
  if (parts.length > 3 || parts.some(part => part === '' || !/^\d+(?:\.\d{1,3})?$/.test(part))) return null
  const seconds = Number(parts.pop())
  const minutes = parts.length ? Number(parts.pop()) : 0
  const hours = parts.length ? Number(parts.pop()) : 0
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours) || seconds >= 60 || minutes >= 60) return null
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000)
}

export function formatTimecode(milliseconds, includeMilliseconds = true) {
  const total = Math.max(0, Math.round(Number(milliseconds) || 0))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const prefix = hours ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes)
  return `${prefix}:${String(seconds).padStart(2, '0')}${includeMilliseconds ? `.${String(millis).padStart(3, '0')}` : ''}`
}

export function clampSelection(startMs, endMs, durationMs, minimumMs = 500, maximumMs = 140_000) {
  let start = Math.max(0, Math.min(Math.round(startMs), Math.max(0, durationMs - minimumMs)))
  let end = Math.max(start + minimumMs, Math.min(Math.round(endMs), durationMs))
  if (end - start > maximumMs) end = start + maximumMs
  if (end > durationMs) {
    end = durationMs
    start = Math.max(0, end - maximumMs)
  }
  return { startMs: start, endMs: end }
}
