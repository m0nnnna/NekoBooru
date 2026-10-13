// Background worker: booru tag lookups for the upload popup, and the
// one-click site imports - sanitizing a content script's import job and
// keeping one import window per post.
//
// Plain script imported by background.js (importScripts) after its constants.

// Read the booru post the download came from, so its own tags - already split
// into artist/character/copyright/meta - come across instead of being guessed
// again locally.
async function collectBooruTags(pageUrl, tabId) {
  const site = detectBooruPost(pageUrl)
  if (!site) return null
  const context = { siteId: site.siteId, label: site.label }

  if (site.preferApi) {
    try {
      const fromApi = site.parse(await fetchBooruJson(site.apiUrl), context)
      if (fromApi) return fromApi
    } catch {
      // Hidden from anonymous requests; the open tab may still list the tags.
    }
    return resultFromScrape(await scrapeBooruTagsFromTab(tabId), context)
  }

  // The open tab first: no request, no rate limit, and the only route that
  // works on Gelbooru, whose API wants credentials we do not ask for.
  const fromDom = resultFromScrape(await scrapeBooruTagsFromTab(tabId), context)
  if (fromDom) return fromDom
  if (!site.apiUsable) return null

  const payload = await fetchBooruJson(site.apiUrl)
  const result = site.parse(payload, context)
  if (result && site.siteId === 'gelbooru') await enrichGelbooruTagTypes(site, result)
  return result
}

async function scrapeBooruTagsFromTab(tabId) {
  const id = Number(tabId)
  if (!Number.isInteger(id) || id < 0 || !chrome.scripting) return null
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: scrapeBooruTagsFromPage,
    })
    return injected?.result || null
  } catch {
    // Tab closed, navigated away, or a page the extension may not touch.
    return null
  }
}

async function fetchBooruJson(url) {
  const response = await fetch(url, { credentials: 'omit' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

// A trace.moe match names its show, not a tag. Find the copyright tag Danbooru
// files it under: each spelling exactly first (aliases resolve, so the English
// title finds a romaji-named tag), then as a prefix for titles long enough not
// to sweep in unrelated shows. Stops at the first hit.
async function lookupTraceMoeSeries(titles) {
  const candidates = traceMoeTagCandidates(Array.isArray(titles) ? titles : []).slice(0, 6)
  for (const candidate of candidates) {
    const patterns = candidate.length >= 8 ? [candidate, `${candidate}*`] : [candidate]
    for (const pattern of patterns) {
      const params = new URLSearchParams({
        'search[name_or_alias_matches]': pattern,
        'search[category]': '3',
        'search[order]': 'count',
        limit: '10',
        only: 'name,category,post_count,is_deprecated',
      })
      let rows = []
      try {
        rows = await fetchBooruJson(`https://danbooru.donmai.us/tags.json?${params}`)
      } catch {
        continue
      }
      const tag = pickDanbooruCopyright(rows)
      if (tag) return { tag, source: 'danbooru', matched: candidate }
    }
  }
  return { tag: '', source: '', candidates }
}

// Gelbooru-family post APIs return one flat tag string, so the categories need
// a second call. Safebooru ignores json=1 there and answers XML.
async function enrichGelbooruTagTypes(site, result) {
  if (!result?.tags?.length) return result
  const url = site.apiUrl
    .replace('s=post', 's=tag')
    .replace(/&id=\d+/, `&limit=${result.tags.length}&names=${encodeURIComponent(result.tags.join(' '))}`)
  try {
    const response = await fetch(url, { credentials: 'omit' })
    if (!response.ok) return result
    const body = (await response.text()).trim()
    const rows = body.startsWith('<') ? parseGelbooruTagTypeXml(body) : JSON.parse(body)
    return applyGelbooruTagTypes(result, rows)
  } catch {
    // Categories are a bonus; the tags themselves are already worth importing.
    return result
  }
}

function sanitizeSiteImportJob(raw, senderUrl) {
  const sender = new URL(senderUrl)
  const job = raw && typeof raw === 'object' ? raw : {}
  if (job.kind === 'pixiv') {
    if (sender.hostname !== 'pixiv.net' && !sender.hostname.endsWith('.pixiv.net')) {
      throw new Error('Pixiv imports can only start from a Pixiv artwork page.')
    }
    const artworkId = sender.pathname.match(/\/artworks\/(\d+)/)?.[1] || ''
    if (!artworkId || String(job.artworkId) !== artworkId) throw new Error('Pixiv artwork ID mismatch.')
    const media = (Array.isArray(job.media) ? job.media : []).slice(0, 200).map((item, index) => {
      const url = new URL(item?.url || '')
      if (url.protocol !== 'https:' || (url.hostname !== 'pximg.net' && !url.hostname.endsWith('.pximg.net'))) {
        throw new Error(`Pixiv page ${index + 1} did not provide a trusted original URL.`)
      }
      const type = item?.type === 'ugoira' ? 'ugoira' : 'image'
      const frames = type === 'ugoira' ? (Array.isArray(item.frames) ? item.frames : []).slice(0, 2000).map((frame) => {
        const file = String(frame?.file || '')
        const delay = Math.round(Number(frame?.delay))
        if (!/^[^\\/]+\.(?:jpe?g|png)$/i.test(file) || !Number.isFinite(delay) || delay < 1 || delay > 60000) {
          throw new Error('Pixiv returned invalid animation frame data.')
        }
        return { file, delay }
      }) : []
      if (type === 'ugoira' && (!url.pathname.toLowerCase().endsWith('.zip') || !frames.length)) {
        throw new Error('Pixiv returned incomplete animation data.')
      }
      return {
        ...item,
        type,
        url: url.href,
        frames,
        tags: (item.tags || []).map(String).filter(Boolean).slice(0, 500),
        tagCategories: item.tagCategories || {},
        tagDisplayNames: item.tagDisplayNames || {},
      }
    })
    if (!media.length) throw new Error('Pixiv returned no original pages.')
    return {
      kind: 'pixiv', artworkId, media,
      title: String(job.title || `Pixiv ${artworkId}`).slice(0, 300),
      artist: String(job.artist || '').slice(0, 200),
      canonicalUrl: `https://www.pixiv.net/en/artworks/${artworkId}`,
      groupTag: `pixiv_${artworkId}`,
      isUgoira: media.some((item) => item.type === 'ugoira'),
    }
  }
  if (job.kind === 'gelbooru') {
    const senderHost = sender.hostname.toLowerCase()
    if (senderHost !== 'gelbooru.com' && !senderHost.endsWith('.gelbooru.com')) {
      throw new Error('Gelbooru imports can only start from Gelbooru.')
    }
    const senderId = sender.searchParams.get('page') === 'post' ? sender.searchParams.get('id') : ''
    if (!/^\d+$/.test(senderId || '') || String(job.postId) !== senderId) {
      throw new Error('Gelbooru post ID mismatch.')
    }
    return {
      kind: 'gelbooru', postId: senderId,
      title: `Gelbooru #${senderId}`,
      pageUrl: `https://gelbooru.com/index.php?page=post&s=view&id=${senderId}`,
      fallbackOriginalUrl: String(job.fallbackOriginalUrl || ''),
      groupTag: `gelbooru_${senderId}`,
    }
  }
  if (job.kind === 'safebooru') {
    if (sender.hostname.replace(/^www\./, '') !== 'safebooru.org') {
      throw new Error('Safebooru imports can only start from Safebooru.')
    }
    return globalThis.NekoBooruSiteImport.sanitizeSafebooruImportJob(job, sender.href)
  }
  if (job.kind === 'gelbooru_search') {
    if (!globalThis.NekoBooruSiteImport.isGelbooruHost(sender.hostname)) {
      throw new Error('Gelbooru imports can only start from Gelbooru.')
    }
    return globalThis.NekoBooruSiteImport.sanitizeGelbooruSearchImportJob(job, sender.href)
  }
  if (job.kind === 'danbooru_search') {
    if (!globalThis.NekoBooruSiteImport.isDanbooruHost(sender.hostname)) {
      throw new Error('Danbooru imports can only start from Danbooru.')
    }
    return globalThis.NekoBooruSiteImport.sanitizeDanbooruSearchImportJob(job, sender.href)
  }
  if (job.kind === 'danbooru') {
    if (!globalThis.NekoBooruSiteImport.isDanbooruHost(sender.hostname)) {
      throw new Error('Danbooru imports can only start from Danbooru.')
    }
    return globalThis.NekoBooruSiteImport.sanitizeDanbooruImportJob(job, sender.href)
  }
  if (job.kind === 'sankaku') {
    if (!globalThis.NekoBooruSiteImport.isSankakuHost(sender.hostname)) {
      throw new Error('Sankaku imports can only start from Sankaku.')
    }
    return globalThis.NekoBooruSiteImport.sanitizeSankakuImportJob(job, sender.href)
  }
  throw new Error('Unsupported site import request.')
}

const SITE_IMPORT_WINDOWS_KEY = 'nekobooruSiteImportWindows'
// Imports whose window is being opened right now, so two quick clicks (the
// cat and the Actions link) cannot both get past the check above.
const openingSiteImports = new Set()

function siteImportPostKey(job) {
  return `${job?.kind || ''}:${job?.postId || job?.artworkId || ''}`
}

// Session storage survives the service worker sleeping, and is cleared with
// the browser session - exactly as long as an import window can exist.
async function siteImportWindows() {
  try {
    return (await chrome.storage.session.get(SITE_IMPORT_WINDOWS_KEY))[SITE_IMPORT_WINDOWS_KEY] || {}
  } catch {
    return {}
  }
}

async function saveSiteImportWindows(windows) {
  try {
    await chrome.storage.session.set({ [SITE_IMPORT_WINDOWS_KEY]: windows })
  } catch {
    // No session storage: duplicates are still refused by the backend.
  }
}

async function rememberSiteImportWindow(postKey, windowId) {
  if (!Number.isInteger(windowId)) return
  const windows = await siteImportWindows()
  windows[postKey] = windowId
  await saveSiteImportWindows(windows)
}

async function focusSiteImportWindow(postKey) {
  const windows = await siteImportWindows()
  const windowId = windows[postKey]
  if (!Number.isInteger(windowId)) return false
  try {
    await chrome.windows.update(windowId, { focused: true, drawAttention: true })
    return true
  } catch {
    // Closed since; forget it and open a fresh one.
    delete windows[postKey]
    await saveSiteImportWindows(windows)
    return false
  }
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  const windows = await siteImportWindows()
  const keys = Object.keys(windows).filter((key) => windows[key] === windowId)
  if (!keys.length) return
  keys.forEach((key) => delete windows[key])
  await saveSiteImportWindows(windows)
})
