const params = new URLSearchParams(location.search)
const jobKey = params.get('job') || ''
const els = {
  title: document.getElementById('title'),
  detail: document.getElementById('detail'),
  progressBar: document.getElementById('progress-bar'),
  status: document.getElementById('status'),
  items: document.getElementById('items'),
  openGroup: document.getElementById('open-group'),
  openOptions: document.getElementById('open-options'),
}
let instanceUrl = ''

init()

async function init() {
  try {
    const stored = await chrome.storage.sync.get('instanceUrl')
    instanceUrl = String(stored.instanceUrl || '').replace(/\/+$/, '')
    if (!instanceUrl) {
      els.openOptions.classList.remove('hidden')
      els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage())
      throw new Error('Set your NekoBooru instance URL in the extension settings first.')
    }
    const jobs = await chrome.storage.local.get(jobKey)
    const job = jobs[jobKey]
    await chrome.storage.local.remove(jobKey)
    if (!job) throw new Error('This import job expired. Click the site button again.')
    await ensureBackend()
    const resolved = job.kind === 'gelbooru' ? await resolveGelbooru(job) : job
    await importAll(resolved)
  } catch (error) {
    setStatus(error?.message || String(error), 'error')
  }
}

async function ensureBackend() {
  if (await backendHealthy()) return
  setStatus('Starting NekoBooru…', 'working')
  try { await chrome.runtime.sendMessage({ type: 'nekobooru-start-local-app' }) } catch { /* show final error below */ }
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (await backendHealthy()) return
  }
  throw new Error('NekoBooru is not running. Start or restart it, then click the import button again.')
}

async function backendHealthy() {
  try {
    const response = await fetch(`${instanceUrl}/api/health`, { cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}

async function resolveGelbooru(job) {
  const response = await fetch(`${instanceUrl}/api/site-imports/gelbooru/${encodeURIComponent(job.postId)}`)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(formatError(data.detail || `Gelbooru metadata failed (HTTP ${response.status}).`))
  return {
    ...job,
    title: `Gelbooru #${data.postId}`,
    canonicalUrl: data.postUrl,
    groupTag: `gelbooru_${data.postId}`,
    media: [{
      url: data.fileUrl || job.fallbackOriginalUrl,
      referer: data.referer || 'https://gelbooru.com/',
      index: 0,
      width: data.width || null,
      height: data.height || null,
      source: data.postUrl,
      tags: data.tags || [],
      tagCategories: data.tagCategories || {},
      tagDisplayNames: data.tagDisplayNames || {},
      safety: data.safety || 'safe',
    }],
  }
}

async function importAll(job) {
  const media = Array.isArray(job.media) ? job.media : []
  if (!media.length) throw new Error('The source returned no original-resolution files.')
  els.title.textContent = job.title || 'Site import'
  els.detail.textContent = job.kind === 'pixiv'
    ? `${media.length} original Pixiv page${media.length === 1 ? '' : 's'} · Pixiv tags included · normal NekoBooru AI setting applies`
    : 'Original Gelbooru file · source tags included · AI disabled'
  renderItems(media)

  const results = []
  let failed = 0
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index]
    setStatus(`Importing ${index + 1} of ${media.length} at original resolution…`, 'working')
    setItem(index, 'working', 'Downloading original…')
    try {
      const result = await importOne(job, item)
      results.push(result)
      setItem(index, 'done', result.duplicate ? `Already existed · post #${result.id}` : `Imported · post #${result.id}`)
    } catch (error) {
      failed += 1
      setItem(index, 'failed', error?.message || String(error))
    }
    els.progressBar.style.width = `${Math.round(((index + 1) / media.length) * 100)}%`
  }

  if (results.length) {
    const query = encodeURIComponent(job.groupTag || '')
    els.openGroup.href = `${instanceUrl}/?q=${query}`
    els.openGroup.classList.remove('hidden')
  }
  if (failed) {
    setStatus(`Finished with ${results.length} imported/already present and ${failed} failed.`, 'error')
    notify('NekoBooru site import finished', `${results.length} succeeded, ${failed} failed.`)
  } else {
    setStatus(`Finished: ${results.length} original file${results.length === 1 ? '' : 's'} imported or already present.`, 'success')
    notify('NekoBooru site import complete', `${results.length} original file${results.length === 1 ? '' : 's'} processed.`)
  }
}

async function importOne(job, item) {
  if (!/^https:\/\//i.test(item.url || '')) throw new Error('Missing original file URL.')
  const upload = await api(`${instanceUrl}/api/uploads/from-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: item.url, referer: item.referer || job.canonicalUrl }),
  })
  const body = {
    contentToken: upload.token,
    safety: item.safety || 'safe',
    tags: item.tags || [],
    tagCategories: item.tagCategories || {},
    tagDisplayNames: item.tagDisplayNames || {},
    source: item.source || job.canonicalUrl,
    autoTagProfile: job.kind === 'pixiv' ? 'pixiv_import' : 'gelbooru_import',
  }
  if (job.kind === 'gelbooru') body.autoTag = false

  const response = await fetch(`${instanceUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (response.ok) return { id: data.id, duplicate: false }
  if (response.status !== 409 || data.detail?.code !== 'duplicate_post') {
    throw new Error(formatError(data.detail || `Post creation failed (HTTP ${response.status}).`))
  }
  return mergeDuplicate(data.detail, item)
}

async function mergeDuplicate(detail, item) {
  let post = detail.post || {}
  const postId = Number(detail.postId || post.id)
  if (!postId) throw new Error('The original already exists, but NekoBooru did not return its post ID.')
  if (detail.deleted || post.deletedAt) {
    post = await api(`${instanceUrl}/api/posts/${postId}/restore`, { method: 'POST' })
  }
  const tags = [...new Set([...(post.tags || []), ...(item.tags || [])])]
  const safety = stricterSafety(post.safety, item.safety)
  await api(`${instanceUrl}/api/posts/${postId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tags,
      safety,
      source: post.source || item.source || null,
      tagCategories: item.tagCategories || {},
      tagDisplayNames: item.tagDisplayNames || {},
    }),
  })
  return { id: postId, duplicate: true }
}

function stricterSafety(first, second) {
  const order = ['safe', 'sketchy', 'unsafe']
  return order[Math.max(order.indexOf(first), order.indexOf(second), 0)]
}

async function api(url, options) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(formatError(data.detail || `HTTP ${response.status}`))
  return data
}

function formatError(detail) {
  if (typeof detail === 'string') return detail
  return detail?.message || JSON.stringify(detail || 'Unknown error')
}

function renderItems(media) {
  els.items.innerHTML = ''
  media.forEach((item, index) => {
    const row = document.createElement('li')
    const dimensions = item.width && item.height ? ` · ${item.width}×${item.height}` : ''
    row.innerHTML = `<span>Page ${index + 1}${dimensions}</span><strong>Waiting</strong>`
    els.items.appendChild(row)
  })
}

function setItem(index, state, text) {
  const row = els.items.children[index]
  if (!row) return
  row.className = state
  row.querySelector('strong').textContent = text
}

function setStatus(message, kind) {
  els.status.textContent = message
  els.status.className = kind || ''
}

function notify(title, message) {
  try {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title, message })
  } catch { /* progress window is still authoritative */ }
}
