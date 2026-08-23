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
  startImport: document.getElementById('start-import'),
}
let instanceUrl = ''
const siteImportCore = globalThis.NekoBooruSiteImport

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
    const response = await NekoAuth.authFetch(`${instanceUrl}/api/health`, { cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}

async function resolveGelbooru(job) {
  const response = await NekoAuth.authFetch(`${instanceUrl}/api/site-imports/gelbooru/${encodeURIComponent(job.postId)}`)
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
  const allMedia = Array.isArray(job.media) ? job.media : []
  if (!allMedia.length) throw new Error('The source returned no original-resolution files.')
  els.title.textContent = job.title || 'Site import'
  els.detail.textContent = job.kind === 'pixiv'
    ? (job.isUgoira
      ? 'Original Pixiv animation · MP4 conversion · Pixiv tags included · AI tagging enabled'
      : `${allMedia.length} original Pixiv page${allMedia.length === 1 ? '' : 's'} · Choose pages below · Pixiv tags included · AI tagging enabled`)
    : `Original ${job.kind === 'safebooru' ? 'Safebooru' : 'Gelbooru'} file · source tags included · AI disabled`
  renderItems(allMedia, job.kind === 'pixiv')

  const media = job.kind === 'pixiv' ? await choosePixivMedia(allMedia) : allMedia

  const results = []
  let failed = 0
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index]
    const rowIndex = Number.isInteger(item.index) ? item.index : allMedia.indexOf(item)
    setStatus(item.type === 'ugoira'
      ? 'Downloading and converting the original animation…'
      : `Importing ${index + 1} of ${media.length} at original resolution…`, 'working')
    setItem(rowIndex, 'working', item.type === 'ugoira' ? 'Converting to MP4…' : 'Downloading original…')
    try {
      const result = await importOne(job, item)
      results.push(result)
      const savedTags = job.kind === 'pixiv' ? 'AI tags saved' : 'source tags saved'
      setItem(rowIndex, 'done', result.duplicate
        ? `Already existed · ${savedTags} · post #${result.id}`
        : `Imported · ${savedTags} · post #${result.id}`)
    } catch (error) {
      failed += 1
      setItem(rowIndex, 'failed', error?.message || String(error))
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

function choosePixivMedia(media) {
  const inputs = Array.from(els.items.querySelectorAll('input[type="checkbox"][data-media-index]'))
  setStatus('Select the Pixiv pages to import, then start the download.', 'working')
  els.startImport.classList.remove('hidden')

  return new Promise((resolve) => {
    const updateCount = () => {
      const count = inputs.filter((input) => input.checked).length
      els.startImport.textContent = `Import selected (${count})`
      els.startImport.disabled = count === 0
    }
    inputs.forEach((input) => input.addEventListener('change', updateCount))
    updateCount()

    els.startImport.addEventListener('click', () => {
      const selectedIndexes = inputs
        .filter((input) => input.checked)
        .map((input) => Number(input.dataset.mediaIndex))
      const selected = siteImportCore.selectedSiteImportMedia(media, selectedIndexes)
      if (!selected.length) return
      inputs.forEach((input) => {
        input.disabled = true
        if (!input.checked) setItem(Number(input.dataset.mediaIndex), 'skipped', 'Skipped')
      })
      els.startImport.classList.add('hidden')
      resolve(selected)
    }, { once: true })
  })
}

async function importOne(job, item) {
  if (!/^https:\/\//i.test(item.url || '')) throw new Error('Missing original file URL.')
  const uploadPath = item.type === 'ugoira' ? 'from-pixiv-ugoira' : 'from-url'
  const uploadPayload = item.type === 'ugoira'
    ? { url: item.url, frames: item.frames }
    : { url: item.url, referer: item.referer || job.canonicalUrl }
  const upload = await api(`${instanceUrl}/api/uploads/${uploadPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(uploadPayload),
  })
  const body = siteImportCore.siteImportPostBody(job, item, upload.token)

  const response = await NekoAuth.authFetch(`${instanceUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (response.ok) return { id: data.id, duplicate: false }
  if (response.status !== 409 || data.detail?.code !== 'duplicate_post') {
    throw new Error(formatError(data.detail || `Post creation failed (HTTP ${response.status}).`))
  }
  return mergeDuplicate(job, data.detail, item)
}

async function mergeDuplicate(job, detail, item) {
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
  if (job.kind === 'pixiv') {
    setStatus(`Post #${postId} already exists; running and saving its AI tags…`, 'working')
    await api(`${instanceUrl}/api/posts/${postId}/auto-tags/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'pixiv_import' }),
    })
  }
  return { id: postId, duplicate: true }
}

function stricterSafety(first, second) {
  const order = ['safe', 'sketchy', 'unsafe']
  return order[Math.max(order.indexOf(first), order.indexOf(second), 0)]
}

async function api(url, options) {
  const response = await NekoAuth.authFetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(formatError(data.detail || `HTTP ${response.status}`))
  return data
}

function formatError(detail) {
  if (typeof detail === 'string') return detail
  return detail?.message || JSON.stringify(detail || 'Unknown error')
}

function renderItems(media, selectable = false) {
  els.items.innerHTML = ''
  media.forEach((item, index) => {
    const row = document.createElement('li')
    const mediaIndex = Number.isInteger(item.index) ? item.index : index
    const dimensions = item.width && item.height ? ` · ${item.width}×${item.height}` : ''
    const description = document.createElement('span')
    description.textContent = item.type === 'ugoira'
      ? `Animation${dimensions} · ${item.frameCount || item.frames?.length || 0} frames`
      : `Page ${mediaIndex + 1}${dimensions}`
    if (selectable) {
      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = true
      input.dataset.mediaIndex = String(mediaIndex)
      label.append(input, description)
      row.appendChild(label)
    } else {
      row.appendChild(description)
    }
    const state = document.createElement('strong')
    state.textContent = 'Waiting'
    row.appendChild(state)
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
