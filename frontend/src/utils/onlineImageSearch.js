const PROVIDERS = {
  google: {
    action: 'https://lens.google.com/v3/upload',
    fileField: 'encoded_image',
  },
}

function searchTargetName(providerId) {
  return `nekobooru-${providerId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function openSearchTarget(providerId, openWindow = window.open) {
  if (!PROVIDERS[providerId]) throw new Error('Unknown online image-search provider.')
  const targetName = searchTargetName(providerId)
  const targetWindow = openWindow('', targetName)
  if (!targetWindow) throw new Error('The browser blocked the search tab. Allow popups for NekoBooru and try again.')
  try {
    targetWindow.document.title = 'NekoBooru online image search'
    targetWindow.document.body.textContent = 'Preparing image search...'
  } catch {
    // A browser can isolate the new tab immediately; the form can still target it.
  }
  return { targetName, targetWindow }
}

export function submitSearchFile(providerId, targetName, file, documentRef = document) {
  const provider = PROVIDERS[providerId]
  if (!provider) throw new Error('Unknown online image-search provider.')
  if (!(file instanceof Blob)) throw new Error('No image was available to search.')

  const form = documentRef.createElement('form')
  form.action = provider.action
  form.method = 'post'
  form.enctype = 'multipart/form-data'
  form.target = targetName
  form.hidden = true

  const input = documentRef.createElement('input')
  input.type = 'file'
  input.name = provider.fileField
  const transfer = new DataTransfer()
  transfer.items.add(file instanceof File ? file : new File([file], 'nekobooru-search.png', { type: file.type || 'image/png' }))
  input.files = transfer.files
  form.appendChild(input)
  documentRef.body.appendChild(form)
  form.submit()
  form.remove()
}

export function requestExtensionReverseSearch(payload, options = {}) {
  const windowRef = options.windowRef || window
  const timeoutMs = options.timeoutMs || 1800
  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      windowRef.removeEventListener('message', onMessage)
      reject(new Error('The NekoBooru browser extension did not respond. Reload or update the extension, then try again.'))
    }, timeoutMs)

    function onMessage(event) {
      const data = event.data
      if (event.source !== windowRef || event.origin !== windowRef.location.origin) return
      if (data?.type !== 'nekobooru-reverse-search-result' || data.requestId !== requestId) return
      clearTimeout(timeout)
      windowRef.removeEventListener('message', onMessage)
      if (data.ok) resolve(data)
      else reject(new Error(data.error || 'The browser extension could not start the reverse search.'))
    }

    windowRef.addEventListener('message', onMessage)
    windowRef.postMessage({
      type: 'nekobooru-reverse-search-request',
      source: 'nekobooru-app',
      requestId,
      mode: 'all',
      ...payload,
    }, windowRef.location.origin)
  })
}
