const statusEl = document.getElementById('status')
const formEl = document.getElementById('lens-form')
const fileInputEl = document.getElementById('encoded-image')
const DB_NAME = 'nekobooruReverseSearch'
const STORE_NAME = 'googleLensUploads'

init()

async function init() {
  try {
    const key = new URLSearchParams(location.search).get('key') || ''
    if (!key) throw new Error('Missing temporary upload key.')

    const payload = await takeUpload(key)
    cleanupOldUploads()

    if (!payload?.blob) throw new Error('Temporary image data was not found.')
    const file = new File([payload.blob], payload.filename || 'nekobooru-search.png', {
      type: payload.blob.type || 'image/png',
    })
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

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open temporary upload storage.'))
  })
}

async function takeUpload(key) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      let payload
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const getRequest = store.get(key)
      getRequest.onsuccess = () => {
        payload = getRequest.result
        store.delete(key)
      }
      getRequest.onerror = () => reject(getRequest.error || new Error('Could not read temporary upload.'))
      tx.oncomplete = () => resolve(payload)
      tx.onerror = () => reject(tx.error || new Error('Could not read temporary upload.'))
    })
  } finally {
    db.close()
  }
}

async function cleanupOldUploads() {
  let db
  try {
    db = await openDb()
    const now = Date.now()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const cursorRequest = store.openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) return
        if (now - (cursor.value?.savedAt || 0) > 10 * 60 * 1000) cursor.delete()
        cursor.continue()
      }
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error || new Error('Could not clean temporary uploads.'))
    })
  } catch {
    // Storage cleanup is best-effort.
  } finally {
    db?.close()
  }
}
