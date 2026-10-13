// Background worker: reverse image search - the per-service menu items,
// frame capture, and handing the media to Google Lens, TinEye or trace.moe.
//
// Plain script imported by background.js (importScripts) after its constants.

function reverseMenuItemId(serviceId) {
  return `${REVERSE_MENU_ID}-${serviceId}`
}

function reversePageMenuItemId(serviceId) {
  return `${REVERSE_PAGE_MENU_ID}-${serviceId}`
}

function reverseSearchTargetUrl(info, tab) {
  const srcUrl = normalizeUploadSrcUrl(info.srcUrl || '')
  if (srcUrl) return srcUrl
  if (lastMediaUrl) return normalizeUploadSrcUrl(lastMediaUrl)
  const linked = info.linkUrl && isVideoPlatformUrl(info.linkUrl) ? info.linkUrl : ''
  const contextualPost = lastPostUrl && isVideoPlatformUrl(lastPostUrl) ? lastPostUrl : ''
  return linked || contextualPost || info.pageUrl || tab?.url || ''
}

function handleReverseSearchClick(info, tab) {
  const id = String(info.menuItemId || '')
  const isFrame = id === REVERSE_FRAME_ID || id === REVERSE_PAGE_FRAME_ID
  const isOpenAll = id === REVERSE_OPEN_ALL_ID || id === REVERSE_PAGE_OPEN_ALL_ID
  const service = REVERSE_SEARCH_SERVICES.find((item) => (
    id === reverseMenuItemId(item.id) || id === reversePageMenuItemId(item.id)
  ))
  if (!isFrame && !isOpenAll && !service) return false

  if (isFrame) {
    captureCurrentFrame(tab, info)
    return true
  }

  const target = reverseSearchTargetUrl(info, tab)
  if (!target) {
    notifyReverseSearch('No media URL found for this right-click.')
    return true
  }
  if (isOpenAll) {
    for (const item of REVERSE_SEARCH_SERVICES) {
      if (item.upload) {
        openReverseUpload(item, tab, info, false)
      } else {
        openReverseSearchTab(item.url(target), tab, false)
      }
    }
    return true
  }
  if (service.upload) {
    openReverseUpload(service, tab, info, true)
    return true
  }
  openReverseSearchTab(service.url(target), tab, true)
  return true
}

function openReverseSearchTab(url, tab, active) {
  const opts = { url, active }
  if (tab?.windowId != null) opts.windowId = tab.windowId
  chrome.tabs.create(opts, () => {
    const error = chrome.runtime.lastError
    if (error) notifyReverseSearch(error.message || 'Could not open reverse search tab.')
  })
}

async function captureCurrentFrame(tab, info) {
  try {
    if (!tab?.id) throw new Error('No active tab.')
    const frameId = Number.isInteger(info.frameId) ? info.frameId : 0
    let result = await sendMessageToFrame(tab.id, frameId, {
      type: 'nekobooru-capture-current-frame',
    })
    if (!result.ok && isMissingContentScriptError(result.error)) {
      const injected = await injectPasteContentScript(tab.id, frameId)
      if (injected.ok) {
        result = await sendMessageToFrame(tab.id, frameId, {
          type: 'nekobooru-capture-current-frame',
        })
      }
    }
    const fallbackUrl = info.srcUrl || lastMediaUrl
    if (!result.ok && fallbackUrl) {
      await chrome.downloads.download({
        url: normalizeUploadSrcUrl(fallbackUrl),
        filename: frameFallbackFilename(fallbackUrl),
        saveAs: false,
      })
      return
    }
    if (!result.ok) throw new Error(result.error || 'Could not capture frame.')
    await chrome.downloads.download({
      url: result.dataUrl,
      filename: result.filename || 'nekobooru-frame.png',
      saveAs: false,
    })
  } catch (e) {
    notifyReverseSearch(e.message || 'Could not capture the current media frame.')
  }
}

async function openReverseUpload(service, tab, info, active = true) {
  if (service.upload === 'trace') {
    openTraceMoeUpload(tab, info, active)
    return
  }
  if (service.upload === 'tineye') {
    openTinEyeUpload(tab, info, active)
    return
  }
  if (service.upload === 'google') {
    openGoogleLensUpload(tab, info, active)
    return
  }

  try {
    const blob = await blobForReverseSearch(tab, info)
    const key = `${service.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await saveReverseUpload(key, {
      blob,
      filename: reverseUploadFilename(info),
      savedAt: Date.now(),
    })
    const page = reverseUploadPage(service.upload)
    const params = new URLSearchParams({ key, service: service.upload })
    const url = chrome.runtime.getURL(`${page}?${params.toString()}`)
    openReverseSearchTab(url, tab, active)
  } catch (e) {
    notifyReverseSearch(e.message || `${service.title} upload failed.`)
  }
}

function reverseUploadPage(uploadType) {
  if (uploadType === 'google') return 'google-lens-upload.html'
  return 'reverse-form-upload.html'
}

async function openTraceMoeUpload(tab, info, active = true) {
  let blob
  try {
    blob = await blobForReverseSearch(tab, info, { landscape: true })
  } catch (e) {
    // A frame of cross-origin media (Gelbooru's video and GIF CDN) cannot be
    // read back from the page. trace.moe can fetch a public URL itself, video
    // included, so hand it the address instead.
    const publicUrl = await publicMediaUrl(info.srcUrl || lastMediaUrl)
    if (publicUrl) {
      openReverseSearchTab(`https://trace.moe/?url=${encodeURIComponent(publicUrl)}`, tab, active)
      return
    }
    notifyReverseSearch(e.message || 'trace.moe upload failed.')
    return
  }
  try {
    const dataUrl = await blobToDataUrl(blob)
    const created = await createReverseSearchTab('https://trace.moe/', tab, active)
    await waitForTabComplete(created.id)
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: created.id },
      func: injectTraceMoeUpload,
      args: [dataUrl, reverseUploadFilename(info)],
    })
    if (!result?.result?.ok) throw new Error(result?.result?.error || 'trace.moe upload injection failed.')
  } catch (e) {
    notifyReverseSearch(e.message || 'trace.moe upload failed.')
  }
}

async function openTinEyeUpload(tab, info, active = true) {
  try {
    const blob = await blobForReverseSearch(tab, info)
    const dataUrl = await blobToDataUrl(blob)
    const created = await createReverseSearchTab('https://tineye.com/', tab, active)
    await waitForTabComplete(created.id, 'TinEye')
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: created.id },
      func: injectTinEyeUpload,
      args: [dataUrl, reverseUploadFilename(info)],
    })
    if (!result?.result?.ok) throw new Error(result?.result?.error || 'TinEye upload injection failed.')
  } catch (e) {
    notifyReverseSearch(e.message || 'TinEye upload failed.')
  }
}

function createReverseSearchTab(url, tab, active) {
  return new Promise((resolve, reject) => {
    const opts = { url, active }
    if (tab?.windowId != null) opts.windowId = tab.windowId
    chrome.tabs.create(opts, (created) => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message || 'Could not open reverse search tab.'))
      else resolve(created)
    })
  })
}

function waitForTabComplete(tabId, serviceName = 'reverse-search site') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error(`${serviceName} did not finish loading.`))
    }, 30000)
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId, (loadedTab) => {
      if (chrome.runtime.lastError) return
      if (loadedTab?.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    })
  })
}

// Google answers a plain form post to lens.google.com/v3/upload with 403 now,
// so this opens Google's home page and hands the file to Lens's own upload box.
async function openGoogleLensUpload(tab, info, active = true) {
  try {
    const blob = await blobForReverseSearch(tab, info)
    const dataUrl = await blobToDataUrl(blob)
    const created = await createReverseSearchTab('https://www.google.com/webhp', tab, active)
    await waitForTabComplete(created.id, 'Google')
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: created.id },
      func: injectGoogleLensUpload,
      args: [dataUrl, reverseUploadFilename(info)],
    })
    if (!result?.result?.ok) throw new Error(result?.result?.error || 'Google Lens upload injection failed.')
  } catch (e) {
    notifyReverseSearch(e.message || 'Google Lens upload failed.')
  }
}

async function injectGoogleLensUpload(dataUrl, filename) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const inputSelector = 'input[type="file"][name="encoded_image"]'
  const buttonSelector = 'div[data-base-lens-url], div[data-is-images-mode], [aria-label="Search by image"]'
  let input = document.querySelector(inputSelector)
  let clicked = false
  for (let i = 0; !input && i < 150; i += 1) {
    // The upload box only exists once the camera button has been opened.
    const button = document.querySelector(buttonSelector)
    if (button && !clicked) {
      button.click()
      clicked = true
    }
    await wait(100)
    input = document.querySelector(inputSelector)
  }
  if (!input) {
    return {
      ok: false,
      error: location.pathname.startsWith('/sorry')
        ? 'Google is asking for a CAPTCHA. Open google.com once, finish it, then try again.'
        : 'Could not find the Google Lens upload box. Accept or dismiss any Google consent prompt, then try again.',
    }
  }

  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const transfer = new DataTransfer()
  transfer.items.add(new File([blob], filename || 'nekobooru-search.png', { type: blob.type || 'image/png' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

async function injectTinEyeUpload(dataUrl, filename) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const fileInputSelector = 'input[type="file"]'
  let input = document.querySelector(fileInputSelector)
  for (let i = 0; !input && i < 300; i += 1) {
    await wait(100)
    input = document.querySelector(fileInputSelector)
  }
  if (!input) {
    return {
      ok: false,
      error: document.title.includes('Just a moment')
        ? 'TinEye is still on its browser check. Open TinEye once, let it finish, then try again.'
        : 'Could not find the TinEye upload input.',
    }
  }

  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const file = new File([blob], filename || 'nekobooru-search.png', {
    type: blob.type || 'image/png',
  })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))

  await wait(500)
  const submit = input.form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
  if (submit && !submit.disabled) submit.click()
  else if (input.form?.requestSubmit) input.form.requestSubmit()

  return { ok: true }
}

async function injectTraceMoeUpload(dataUrl, filename) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let image = document.querySelector('#originalImage')
  for (let i = 0; !image && i < 150; i += 1) {
    await wait(100)
    image = document.querySelector('#originalImage')
  }
  if (!image) return { ok: false, error: 'Could not find the trace.moe search image target.' }

  image.src = dataUrl
  return { ok: true }
}

function reverseUploadFilename(info) {
  if (info.dataUrl && info.filename) return info.filename
  const raw = info.srcUrl || lastMediaUrl || ''
  const base = filenameFromUrl(raw || 'nekobooru-search.png')
  if (shouldCaptureFrameForUpload(info, raw)) return base.replace(/\.[^.]+$/, '') + '-frame.png'
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(base)) return base
  return base.replace(/\.[^.]+$/, '') + '.png'
}

// A media URL another site's server can fetch: http(s), and not this
// NekoBooru instance (its media needs the login) or another local address.
async function publicMediaUrl(raw) {
  let url
  try {
    url = new URL(normalizeUploadSrcUrl(raw || ''))
  } catch {
    return ''
  }
  if (!/^https?:$/.test(url.protocol)) return ''
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return ''
  if (await isTrustedNekoBooruPage(url.href)) return ''
  return url.href
}

async function blobForReverseSearch(tab, info, options = {}) {
  if (info.dataUrl) return dataUrlToBlob(info.dataUrl)
  const directUrl = info.srcUrl || lastMediaUrl
  const preferFrame = shouldCaptureFrameForUpload(info, directUrl)
  if (directUrl && !preferFrame) {
    try {
      const response = await fetch(normalizeUploadSrcUrl(directUrl), { credentials: 'include' })
      if (response.ok) return await response.blob()
    } catch {
      // Fall back to content-script frame capture below.
    }
  }

  if (!tab?.id) throw new Error('No active tab for frame capture.')
  const frameId = Number.isInteger(info.frameId) ? info.frameId : 0
  let result = await sendMessageToFrame(tab.id, frameId, {
    type: 'nekobooru-capture-current-frame',
    landscape: !!options.landscape,
  })
  if (!result.ok && isMissingContentScriptError(result.error)) {
    const injected = await injectPasteContentScript(tab.id, frameId)
    if (injected.ok) {
      result = await sendMessageToFrame(tab.id, frameId, {
        type: 'nekobooru-capture-current-frame',
        landscape: !!options.landscape,
      })
    }
  }
  if (!result.ok || !result.dataUrl) {
    // A GIF is still an image every provider takes: when its frame cannot be
    // read back (cross-origin), send the file itself.
    if (directUrl && /\.gif(?:$|[?#])/i.test(directUrl)) {
      try {
        const response = await fetch(normalizeUploadSrcUrl(directUrl), { credentials: 'include' })
        if (response.ok) return await response.blob()
      } catch {
        // Fall through to the capture error.
      }
    }
    throw new Error(result.error || 'Could not capture media frame.')
  }
  return dataUrlToBlob(result.dataUrl)
}

function shouldCaptureFrameForUpload(info, raw = '') {
  const target = String(raw || info?.srcUrl || lastMediaUrl || '').toLowerCase()
  const mediaType = String(info?.mediaType || lastMediaType || '').toLowerCase()
  return (
    mediaType === 'video' ||
    target.includes('.mp4') ||
    target.includes('.webm') ||
    target.includes('.mov') ||
    target.includes('.m4v') ||
    target.includes('.gif')
  )
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match) throw new Error('Captured frame was not a valid image.')
  const mime = match[1] || 'image/png'
  const isBase64 = !!match[2]
  const raw = isBase64 ? atob(match[3]) : decodeURIComponent(match[3])
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

function openReverseUploadDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REVERSE_UPLOAD_DB, 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(REVERSE_UPLOAD_STORE)) {
        request.result.createObjectStore(REVERSE_UPLOAD_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open temporary upload storage.'))
  })
}

async function saveReverseUpload(key, payload) {
  const db = await openReverseUploadDb()
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(REVERSE_UPLOAD_STORE, 'readwrite')
      tx.objectStore(REVERSE_UPLOAD_STORE).put(payload, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error || new Error('Could not save temporary reverse-search upload.'))
    })
  } finally {
    db.close()
  }
}

function notifyReverseSearch(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'NekoBooru reverse image search',
    message,
  })
}

function frameFallbackFilename(raw) {
  const name = filenameFromUrl(raw)
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name.replace(/(\.[a-z0-9]{2,5})$/i, '-frame$1')
  return `${name}-frame`
}
