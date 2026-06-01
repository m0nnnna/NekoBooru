const instanceInput = document.getElementById('instance')
const saveBtn = document.getElementById('save')
const testBtn = document.getElementById('test')
const status = document.getElementById('status')

init()

async function init() {
  const stored = await chrome.storage.sync.get('instanceUrl')
  if (stored.instanceUrl) instanceInput.value = stored.instanceUrl

  saveBtn.addEventListener('click', save)
  testBtn.addEventListener('click', testConnection)
}

function normalize(url) {
  return url.trim().replace(/\/+$/, '')
}

function setStatus(message, kind) {
  status.textContent = message
  status.className = `status ${kind || ''}`
  status.classList.remove('hidden')
}

async function save() {
  const url = normalize(instanceInput.value)
  if (!url) {
    setStatus('Please enter an instance URL.', 'error')
    return
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('URL must start with http:// or https://', 'error')
    return
  }
  await chrome.storage.sync.set({ instanceUrl: url })
  setStatus('Saved! You can now right-click images to upload them.', 'success')
}

async function testConnection() {
  const url = normalize(instanceInput.value)
  if (!url) {
    setStatus('Enter an instance URL first.', 'error')
    return
  }
  setStatus('Testing...', 'working')
  try {
    const res = await fetch(`${url}/api/health`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    setStatus(`Connected to ${data.service || 'NekoBooru'}! Nyaa~`, 'success')
  } catch (e) {
    setStatus('Could not reach instance: ' + e.message, 'error')
  }
}
