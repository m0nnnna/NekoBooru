const statusEl = document.getElementById('status')
const formEl = document.getElementById('lens-form')
const fileInputEl = document.getElementById('encoded-image')

init()

async function init() {
  try {
    const key = new URLSearchParams(location.search).get('key') || ''
    if (!key) throw new Error('Missing temporary upload key.')

    const stored = await chrome.storage.local.get(key)
    const payload = stored[key]
    await chrome.storage.local.remove(key)
    cleanupOldUploads()

    if (!payload?.dataUrl) throw new Error('Temporary image data was not found.')
    const file = await fileFromDataUrl(payload.dataUrl, payload.filename || 'nekobooru-search.png')
    const transfer = new DataTransfer()
    transfer.items.add(file)
    fileInputEl.files = transfer.files
    formEl.querySelector('[name="filename"]').value = file.name
    statusEl.textContent = 'Submitting image to Google Lens...'
    formEl.submit()
  } catch (error) {
    statusEl.textContent = error.message || 'Could not upload to Google Lens.'
    statusEl.classList.add('error')
  }
}

async function fileFromDataUrl(dataUrl, filename) {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], filename, { type: blob.type || 'image/png' })
}

async function cleanupOldUploads() {
  try {
    const rows = await chrome.storage.local.get(null)
    const now = Date.now()
    const remove = Object.entries(rows)
      .filter(([key, value]) => key.startsWith('nekobooruGoogleLensUpload:') && now - (value?.savedAt || 0) > 10 * 60 * 1000)
      .map(([key]) => key)
    if (remove.length) await chrome.storage.local.remove(remove)
  } catch {
    // Storage cleanup is best-effort.
  }
}
