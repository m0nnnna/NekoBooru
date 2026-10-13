export function formatFileSize(bytes) {
  const value = Number(bytes || 0)
  if (!value) return 'unknown'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function truncateText(value, maxLength = 60) {
  const text = String(value || '')
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
}

export function formatDurationMs(ms) {
  const value = Number(ms || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}
