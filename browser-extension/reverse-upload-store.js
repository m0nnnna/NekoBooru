const DB_NAME = 'nekobooruReverseSearch'
const STORE_NAME = 'reverseSearchUploads'

function openReverseUploadDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open temporary upload storage.'))
  })
}

async function takeReverseUpload(key) {
  const db = await openReverseUploadDb()
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

async function cleanupOldReverseUploads() {
  let db
  try {
    db = await openReverseUploadDb()
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

function fileFromReverseUpload(payload, fallbackName = 'nekobooru-search.png') {
  if (!payload?.blob) throw new Error('Temporary image data was not found.')
  return new File([payload.blob], payload.filename || fallbackName, {
    type: payload.blob.type || 'image/png',
  })
}
