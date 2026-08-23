const instanceInput = document.getElementById('instance')
const apiTokenInput = document.getElementById('api-token')
const saveTweetTagInput = document.getElementById('save-tweet-tag')
const saveTweetUsernameInput = document.getElementById('save-tweet-username')
const saveSourcePageUrlInput = document.getElementById('save-source-page-url')
const saveMediaUrlInput = document.getElementById('save-media-url')
const booruSuggestInput = document.getElementById('booru-suggest')
const booruSuggestState = document.getElementById('booru-suggest-state')
const saveBtn = document.getElementById('save')
const testBtn = document.getElementById('test')
const status = document.getElementById('status')
const loginUsernameInput = document.getElementById('login-username')
const loginPasswordInput = document.getElementById('login-password')
const loginBtn = document.getElementById('login')
const logoutBtn = document.getElementById('logout')
const loggedOutView = document.getElementById('logged-out-view')
const loggedInView = document.getElementById('logged-in-view')
const loggedInUsername = document.getElementById('logged-in-username')

// Booru suggestions are an instance setting, not a browser one, so this page
// can only offer the switch once it has reached the instance. Null means "not
// loaded" - saving must then leave the server's value alone rather than push
// an unchecked box over it.
let booruSuggestLoaded = null

init()

async function init() {
  const stored = await chrome.storage.sync.get([
    'instanceUrl',
    'apiToken',
    'accountUsername',
    'saveTweetTag',
    'saveTweetUsername',
    'saveSourcePageUrl',
    'saveMediaUrl',
  ])
  if (stored.instanceUrl) instanceInput.value = stored.instanceUrl
  if (stored.apiToken) apiTokenInput.value = stored.apiToken
  saveTweetTagInput.checked = stored.saveTweetTag !== false
  saveTweetUsernameInput.checked = stored.saveTweetUsername === true
  saveSourcePageUrlInput.checked = stored.saveSourcePageUrl !== false
  saveMediaUrlInput.checked = stored.saveMediaUrl === true
  refreshLoginView(stored.apiToken, stored.accountUsername)

  saveBtn.addEventListener('click', save)
  testBtn.addEventListener('click', testConnection)
  loginBtn.addEventListener('click', login)
  logoutBtn.addEventListener('click', logout)
  // Re-read the instance setting when the URL is pointed somewhere else.
  instanceInput.addEventListener('change', () => loadInstanceOptions())
  loadInstanceOptions()
}

function refreshLoginView(token, username) {
  const loggedIn = Boolean(token)
  loggedOutView.classList.toggle('hidden', loggedIn)
  loggedInView.classList.toggle('hidden', !loggedIn)
  if (loggedIn) loggedInUsername.textContent = username || '(saved token)'
}

// Logs in against the instance directly and stores the token it returns -
// an alternative to generating one in the web UI and pasting it into the
// "Use an API token instead" field below. Session cookies don't work here:
// this page is a different site from the instance, so a SameSite=Lax
// session cookie set by /api/auth/login would never be sent back on the
// extension's later cross-site fetches.
async function login() {
  const url = normalize(instanceInput.value)
  if (!url) {
    setStatus('Enter the instance URL above first.', 'error')
    return
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('URL must start with http:// or https://', 'error')
    return
  }
  const username = loginUsernameInput.value.trim()
  const password = loginPasswordInput.value
  if (!username || !password) {
    setStatus('Enter your username and password.', 'error')
    return
  }
  setStatus('Logging in…', 'working')
  try {
    const res = await fetch(`${url}/api/auth/token-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, label: 'Browser Extension' }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      throw new Error(detail?.detail || `HTTP ${res.status}`)
    }
    const data = await res.json()
    await chrome.storage.sync.set({ instanceUrl: url, apiToken: data.token, accountUsername: data.username })
    apiTokenInput.value = data.token
    loginPasswordInput.value = ''
    refreshLoginView(data.token, data.username)
    setStatus(`Logged in as ${data.username}! You can now right-click images to upload them.`, 'success')
    loadInstanceOptions()
  } catch (e) {
    setStatus(`Could not log in: ${e.message}`, 'error')
  }
}

async function logout() {
  await chrome.storage.sync.remove(['apiToken', 'accountUsername'])
  apiTokenInput.value = ''
  refreshLoginView(null, null)
  setStatus('Logged out.', 'success')
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
    const res = await NekoAuth.authFetch(`${url}/api/auto-tags/settings`)
    if (res.status === 401) throw new Error('set your API token below first')
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
  const res = await NekoAuth.authFetch(`${url}/api/auto-tags/settings`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const current = await res.json()
  const put = await NekoAuth.authFetch(`${url}/api/auto-tags/settings`, {
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
  const newToken = apiTokenInput.value.trim()
  const prior = await chrome.storage.sync.get(['apiToken', 'accountUsername'])
  // If the token field was hand-edited (pasted, cleared) rather than left as
  // whatever login()/init() put there, the username label attached to the
  // old token no longer applies to it.
  const accountUsername = newToken === prior.apiToken ? prior.accountUsername : undefined
  await chrome.storage.sync.set({
    instanceUrl: url,
    apiToken: newToken,
    accountUsername: accountUsername || '',
    saveTweetTag: saveTweetTagInput.checked,
    saveTweetUsername: saveTweetUsernameInput.checked,
    saveSourcePageUrl: saveSourcePageUrlInput.checked,
    saveMediaUrl: saveMediaUrlInput.checked,
  })
  refreshLoginView(newToken, accountUsername)
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
