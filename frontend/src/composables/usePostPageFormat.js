// Formatting and source-link helpers for the post page.

export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function formatFullDate(dateStr) {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// "2h ago" for recent uploads; older ones fall back to the short date.
export function formatRelativeDate(dateStr) {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return ''
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const steps = [
    [60, 'm'],
    [24, 'h'],
    [7, 'd'],
  ]
  let value = seconds / 60
  for (const [limit, unit] of steps) {
    if (value < limit) return `${Math.floor(value)}${unit} ago`
    value /= limit
  }
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

export function tweetIdFromPost(value) {
  if (!value) return ''
  const tag = (value.tags || []).find((name) => /^twitter_\d+$/.test(name) || /^tweet_\d+$/.test(name))
  if (tag) return tag.match(/\d+/)?.[0] || ''
  return tweetIdFromUrl(value.source)
}

export function tweetIdFromUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return ''
    return url.pathname.match(/\/status\/(\d+)/)?.[1] || ''
  } catch {
    return ''
  }
}

// Mirrors BOORU_SITES in browser-extension/booru-tags.js - keep the host
// lists in step. Only used to label a link back to post.source, so it needs
// no post-id parsing of its own: several of these siteIds (gelbooru,
// moebooru) cover multiple actual domains, so there is no way to rebuild a
// working URL from a saved "gelbooru_12345"-style tag alone. post.source -
// the exact page the post was downloaded from - is the only reliable source.
export const BOORU_SOURCE_HOSTS = [
  { label: 'Danbooru', matches: (host) => host === 'donmai.us' || host.endsWith('.donmai.us') },
  { label: 'e621', matches: (host) => host === 'e621.net' || host === 'e926.net' },
  { label: 'Moebooru', matches: (host) => ['yande.re', 'konachan.com', 'konachan.net'].includes(host) },
  {
    label: 'Gelbooru',
    matches: (host) => [
      'gelbooru.com',
      'safebooru.org',
      'rule34.xxx',
      'tbib.org',
      'xbooru.com',
      'realbooru.com',
      'hypnohub.net',
    ].includes(host),
  },
  {
    label: 'Sankaku',
    matches: (host) => ['sankaku.app', 'chan.sankakucomplex.com', 'sankakucomplex.com'].includes(host),
  },
]

export function booruSourceLinkFromPost(value) {
  const raw = value?.source
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  const site = BOORU_SOURCE_HOSTS.find((entry) => entry.matches(host))
  return site ? { url: raw, label: site.label } : null
}
