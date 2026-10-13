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
const SITE_LABELS = {
  gelbooru: 'Gelbooru',
  gelbooru_search: 'Gelbooru',
  safebooru: 'Safebooru',
  danbooru: 'Danbooru',
  danbooru_search: 'Danbooru',
  sankaku: 'Sankaku',
}
const BATCH_KINDS = new Set(['danbooru_search', 'gelbooru_search'])
// A search page imports one post after another, never in parallel, with a
// pause between downloads so a big page cannot trip the site's limits. A
// 429/503 backs off and retries rather than failing the post.
const BATCH_DOWNLOAD_GAP_MS = 1500
const BATCH_RETRY_DELAYS_MS = [10000, 30000, 60000]

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
    const resolved = job.kind === 'gelbooru'
      ? await resolveGelbooru(job)
      : (job.kind === 'gelbooru_search' ? await resolveGelbooruSearch(job) : job)
    // Safebooru's API has no tag categories: Danbooru's fill in what the page left general.
    if (resolved.kind === 'safebooru') setStatus('Looking up tag categories…', 'working')
    await globalThis.NekoBooruDanbooruCategories?.applyDanbooruCategories(resolved)
    const renames = await useDanbooruNames(resolved)
    await importAll(resolved)
    await aliasSourceNames(renames)
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

// The backend holds the Gelbooru API key, so it resolves the page's posts:
// one search call for the page plus the tag types, shared by every post.
async function resolveGelbooruSearch(job) {
  setStatus('Looking up the posts on this page…', 'working')
  const data = await api(`${instanceUrl}/api/site-imports/gelbooru-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: job.tags || '', offset: job.offset || 0, ids: (job.ids || []).map(Number) }),
  })
  return {
    ...job,
    unavailable: (data.missing || []).map((entry) => ({ postId: String(entry.postId), reason: entry.reason || '' })),
    media: siteImportCore.gelbooruSearchMedia(data),
  }
}

// Sankaku spells qualified characters and series in full -
// honoka_(dead_or_alive) - where Danbooru, Gelbooru, and Safebooru write
// honoka_(doa). Take Danbooru's spelling so one character stays one tag.
// Best effort: if the lookup fails the Sankaku names are imported unchanged.
async function useDanbooruNames(job) {
  if (job.kind !== 'sankaku') return {}
  const media = Array.isArray(job.media) ? job.media : []
  const tags = [...new Set(media.flatMap((item) => item.tags || []))]
  const tagCategories = Object.assign({}, ...media.map((item) => item.tagCategories || {}))
  let renames = {}
  try {
    const data = await api(`${instanceUrl}/api/site-imports/danbooru-names`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags, tagCategories }),
    })
    renames = data.renames || {}
  } catch {
    return {}
  }
  for (const item of media) {
    item.tags = [...new Set((item.tags || []).map((tag) => renames[tag] || tag))]
    for (const [from, to] of Object.entries(renames)) {
      if (!item.tagCategories?.[from]) continue
      item.tagCategories[to] = item.tagCategories[from]
      delete item.tagCategories[from]
    }
  }
  return renames
}

// Keep the source's spelling as an alias of the Danbooru one, so typing it
// later lands on the same tag and a tag already imported under it is merged.
// It is also stored as the tag's Sankaku name, which Sankaku searches use.
async function aliasSourceNames(renames) {
  for (const [alias, target] of Object.entries(renames || {})) {
    try {
      await NekoAuth.authFetch(`${instanceUrl}/api/tag-aliases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias, target, sankakuName: alias }),
      })
    } catch {
      // Already an alias, or NekoBooru went away; the post is imported either way.
    }
  }
}

async function importAll(job) {
  const allMedia = Array.isArray(job.media) ? job.media : []
  if (!allMedia.length) throw new Error('The source returned no original-resolution files.')
  els.title.textContent = job.title || 'Site import'
  const batch = BATCH_KINDS.has(job.kind)
  const siteLabel = SITE_LABELS[job.kind] || 'Gelbooru'
  const unavailable = Array.isArray(job.unavailable) ? job.unavailable : []
  els.detail.textContent = job.kind === 'pixiv'
    ? (job.isUgoira
      ? 'Original Pixiv animation · MP4 conversion · Pixiv tags included · AI tagging enabled'
      : `${allMedia.length} original Pixiv page${allMedia.length === 1 ? '' : 's'} · Choose pages below · Pixiv tags included · AI tagging enabled`)
    : batch
      ? `${allMedia.length} original ${siteLabel} file${allMedia.length === 1 ? '' : 's'} · one at a time · posts already in NekoBooru are not downloaded again · AI disabled`
        + (unavailable.length ? ` · ${unavailable.length} withheld by ${siteLabel}` : '')
      : `Original ${SITE_LABELS[job.kind] || 'Gelbooru'} file · source tags included · AI disabled`
  renderItems(allMedia, job.kind === 'pixiv')

  const media = job.kind === 'pixiv' ? await choosePixivMedia(allMedia) : allMedia

  const results = []
  let failed = 0
  let downloadedLast = false
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index]
    const rowIndex = Number.isInteger(item.index) ? item.index : allMedia.indexOf(item)
    setStatus(item.type === 'ugoira'
      ? 'Downloading and converting the original animation…'
      : `Importing ${index + 1} of ${media.length} at original resolution…`, 'working')
    setItem(rowIndex, 'working', item.type === 'ugoira' ? 'Converting to MP4…' : 'Downloading original…')
    try {
      const existing = batch ? await existingImportedPost(item) : null
      if (existing) {
        setItem(rowIndex, 'working', 'Already in NekoBooru · merging tags…')
        const merged = await mergeDuplicate(job, { postId: existing.id, post: existing }, item)
        results.push(merged)
        setItem(rowIndex, 'done', `Already existed · not downloaded · tags merged · post #${merged.id}`)
        downloadedLast = false
      } else {
        if (batch && downloadedLast) await sleep(BATCH_DOWNLOAD_GAP_MS)
        const result = batch
          ? await importWithBackoff(job, item, rowIndex)
          : await importOne(job, item, (text) => setItem(rowIndex, 'working', text))
        downloadedLast = true
        results.push(result)
        const savedTags = job.kind === 'pixiv' ? 'AI tags saved' : 'source tags saved'
        setItem(rowIndex, 'done', result.duplicate
          ? `Already existed · ${savedTags} · post #${result.id}`
          : `Imported · ${savedTags} · post #${result.id}`)
      }
    } catch (error) {
      failed += 1
      setItem(rowIndex, 'failed', error?.message || String(error))
    }
    els.progressBar.style.width = `${Math.round(((index + 1) / media.length) * 100)}%`
  }

  if (results.length && job.groupTag) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A post an earlier import already brought in, found by the <site>_<id> tag
// every booru import carries. Only an exact tag match counts: semantic search
// may widen the query, and a near miss must never skip a download.
async function existingImportedPost(item) {
  const idTag = item.idTag || `danbooru_${item.postId}`
  try {
    const data = await api(`${instanceUrl}/api/posts?${new URLSearchParams({ q: idTag, limit: '5' })}`)
    return (data.results || []).find((post) => (post.tags || []).includes(idTag)) || null
  } catch {
    return null
  }
}

// The site (or its CDN) saying "slow down" is not a failed post: wait and try
// the same file again, longer each time.
async function importWithBackoff(job, item, rowIndex) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await importOne(job, item, (text) => setItem(rowIndex, 'working', text))
    } catch (error) {
      const message = error?.message || String(error)
      const delay = BATCH_RETRY_DELAYS_MS[attempt]
      if (!/HTTP (429|503)\b/.test(message) || delay === undefined) throw error
      const site = SITE_LABELS[job.kind] || 'The site'
      setItem(rowIndex, 'working', `${site} asked to slow down · retrying in ${Math.round(delay / 1000)} s…`)
      setStatus(`${site} is rate limiting; waiting ${Math.round(delay / 1000)} s before retrying.`, 'working')
      await sleep(delay)
    }
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

async function importOne(job, item, onProgress = () => {}) {
  if (!/^https:\/\//i.test(item.url || '')) throw new Error('Missing original file URL.')
  const uploadPath = item.type === 'ugoira' ? 'from-pixiv-ugoira' : 'from-url'
  const progressId = item.type === 'ugoira' ? '' : crypto.randomUUID()
  const uploadPayload = item.type === 'ugoira'
    ? { url: item.url, frames: item.frames }
    : { url: item.url, referer: item.referer || job.canonicalUrl, progressId }
  const stopFollowing = progressId ? followDownload(progressId, onProgress) : () => {}
  let upload
  try {
    upload = await api(`${instanceUrl}/api/uploads/${uploadPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadPayload),
    })
  } finally {
    stopFollowing()
  }
  onProgress('Saving post…')
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

// Poll the backend's byte count for a download once a second. Returns the
// function that stops polling.
function followDownload(progressId, onProgress) {
  const started = Date.now()
  let stopped = false
  let timer = null
  const tick = async () => {
    try {
      const response = await NekoAuth.authFetch(
        `${instanceUrl}/api/uploads/from-url/progress/${encodeURIComponent(progressId)}`,
        { cache: 'no-store' },
      )
      if (response.ok && !stopped) {
        onProgress(siteImportCore.downloadProgressText(await response.json(), Date.now() - started))
      }
    } catch {
      // Progress is a courtesy; the download itself carries on regardless.
    }
    if (!stopped) timer = setTimeout(tick, 1000)
  }
  timer = setTimeout(tick, 1000)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
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
      : `${item.label || `Page ${mediaIndex + 1}`}${dimensions}`
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
