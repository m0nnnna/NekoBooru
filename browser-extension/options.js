const instanceInput = document.getElementById('instance')
const saveTweetTagInput = document.getElementById('save-tweet-tag')
const saveTweetUsernameInput = document.getElementById('save-tweet-username')
const saveSourcePageUrlInput = document.getElementById('save-source-page-url')
const saveMediaUrlInput = document.getElementById('save-media-url')
const booruSuggestInput = document.getElementById('booru-suggest')
const booruSuggestState = document.getElementById('booru-suggest-state')
const saveBtn = document.getElementById('save')
const testBtn = document.getElementById('test')
const status = document.getElementById('status')

// Booru suggestions are an instance setting, not a browser one, so this page
// can only offer the switch once it has reached the instance. Null means "not
// loaded" - saving must then leave the server's value alone rather than push
// an unchecked box over it.
let booruSuggestLoaded = null

init()

async function init() {
  const stored = await chrome.storage.sync.get([
    'instanceUrl',
    'saveTweetTag',
    'saveTweetUsername',
    'saveSourcePageUrl',
    'saveMediaUrl',
  ])
  if (stored.instanceUrl) instanceInput.value = stored.instanceUrl
  saveTweetTagInput.checked = stored.saveTweetTag !== false
  saveTweetUsernameInput.checked = stored.saveTweetUsername === true
  saveSourcePageUrlInput.checked = stored.saveSourcePageUrl !== false
  saveMediaUrlInput.checked = stored.saveMediaUrl === true

  saveBtn.addEventListener('click', save)
  testBtn.addEventListener('click', testConnection)
  // Re-read the instance setting when the URL is pointed somewhere else.
  instanceInput.addEventListener('change', () => loadInstanceOptions())
  loadInstanceOptions()
}

async function loadInstanceOptions() {
  const url = normalize(instanceInput.value)
  booruSuggestLoaded = null
  booruSuggestInput.disabled = true
  if (!url) {
    booruSuggestState.textContent = 'Set your instance URL to change this.'
    return
  }
  booruSuggestState.textContent = 'Reading this setting from your instance…'
  try {
    const res = await fetch(`${url}/api/auto-tags/settings`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const settings = await res.json()
    booruSuggestLoaded = settings.booruSuggestEnabled === true
    booruSuggestInput.checked = booruSuggestLoaded
    booruSuggestInput.disabled = false
    booruSuggestState.textContent = booruSuggestLoaded
      ? 'On. Remote tags appear in the popup marked with the board they came from.'
      : 'Off. The popup can only suggest tags already in your library.'
  } catch (e) {
    booruSuggestState.textContent = `Could not read it from the instance (${e.message}). Save your instance URL first, or change this in the web UI.`
  }
}

// The instance settings endpoint replaces the whole auto-tagging block, so the
// current settings have to be re-read and handed back with the one key changed.
async function saveBooruSuggest(url) {
  if (booruSuggestLoaded === null || booruSuggestInput.checked === booruSuggestLoaded) return
  const res = await fetch(`${url}/api/auto-tags/settings`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const current = await res.json()
  const put = await fetch(`${url}/api/auto-tags/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settings: { ...current, booruSuggestEnabled: booruSuggestInput.checked },
    }),
  })
  if (!put.ok) throw new Error(`HTTP ${put.status}`)
  booruSuggestLoaded = booruSuggestInput.checked
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
  await chrome.storage.sync.set({
    instanceUrl: url,
    saveTweetTag: saveTweetTagInput.checked,
    saveTweetUsername: saveTweetUsernameInput.checked,
    saveSourcePageUrl: saveSourcePageUrlInput.checked,
    saveMediaUrl: saveMediaUrlInput.checked,
  })
  // The browser-side options are saved either way; only the instance one can
  // fail here, so it reports itself without taking the rest down with it.
  try {
    await saveBooruSuggest(url)
  } catch (e) {
    setStatus(`Saved, but booru tag suggestions could not be changed on the instance: ${e.message}`, 'error')
    loadInstanceOptions()
    return
  }
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
    loadInstanceOptions()
  } catch (e) {
    setStatus('Could not reach instance: ' + e.message, 'error')
  }
}
