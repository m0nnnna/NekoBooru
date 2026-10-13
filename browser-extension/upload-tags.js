// Upload popup: the tag box - pills, autocomplete, and the categories and
// display names that travel with the submitted tags.
//
// Plain script sharing upload.html's global scope; loaded before upload.js.

// The categories for the tags actually being submitted.
function pickTagCategories(submittedTags) {
  const picked = {}
  ;(submittedTags || []).forEach((tag) => {
    const category = knownTagCategories[tag]
    if (category && category !== 'general') picked[tag] = category
  })
  return picked
}

// NekoBooru flattens "miyu_(blue_archive)" to "miyu_blue_archive", so pass the
// qualifier spelling along as the display name and the sidebar can show
// "miyu (blue archive)" the way the source booru did.
function pickTagDisplayNames(submittedTags) {
  const picked = {}
  ;(submittedTags || []).forEach((tag) => {
    if (knownTagDisplayNames[tag]) picked[tag] = knownTagDisplayNames[tag]
    else if (knownTagCategories[tag] && tag.includes('(')) picked[tag] = tag.replace(/_/g, ' ')
  })
  return picked
}

// ---------------------------------------------------------------------------
// Tags: confirmed tags become solid pills (mirrors the web UI's TagInput), the
// text input only ever holds the tag currently being typed. Autocomplete
// queries that single in-progress word.
// ---------------------------------------------------------------------------

let debounceTimer = null
let selectedIndex = -1
let currentSuggestions = []
let tags = []

function setupTagAutocomplete() {
  els.tags.addEventListener('input', onTagInput)
  els.tags.addEventListener('keydown', onTagKeydown)
  els.tags.addEventListener('blur', () => {
    // Delay so a click on a suggestion still registers
    setTimeout(() => {
      hideSuggestions()
      commitInput()
    }, 150)
  })
}

// Normalise a raw tag the way the web UI does: lowercase, spaces -> underscores.
function normalizeTag(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, '_')
}

function addTags(raw) {
  let added = false
  for (const part of raw.split(',')) {
    const tag = normalizeTag(part)
    if (tag && !tags.includes(tag)) {
      tags.push(tag)
      added = true
    }
  }
  if (added) renderPills()
}

// Turn whatever is currently in the input into pill(s).
function commitInput() {
  if (!els.tags.value.trim()) return
  addTags(els.tags.value)
  els.tags.value = ''
  hideSuggestions()
}

function renderPills() {
  els.tagPills.innerHTML = ''
  tags.forEach((tag) => {
    const pill = document.createElement('span')
    pill.className = 'tag'
    pill.textContent = tag
    const remove = document.createElement('button')
    remove.className = 'remove-tag'
    remove.type = 'button'
    remove.innerHTML = '&times;'
    remove.setAttribute('aria-label', `Remove ${tag}`)
    remove.addEventListener('click', () => removeTag(tag))
    pill.appendChild(remove)
    els.tagPills.appendChild(pill)
  })
}

function setTags(nextTags) {
  tags = [...new Set((nextTags || []).map(normalizeTag).filter(Boolean))]
  renderPills()
}

function removeTag(tag) {
  tags = tags.filter((t) => t !== tag)
  renderPills()
  els.tags.focus()
}

// Bumped per lookup, so a slow answer for an older word cannot replace a newer one.
let suggestSeq = 0

function onTagInput() {
  // A comma finalises every tag before it, keeping only the trailing fragment.
  if (els.tags.value.includes(',')) {
    const parts = els.tags.value.split(',')
    const remainder = parts.pop()
    addTags(parts.join(','))
    els.tags.value = remainder
  }

  clearTimeout(debounceTimer)
  const word = els.tags.value.trim()
  const seq = ++suggestSeq
  if (!word) {
    hideSuggestions()
    return
  }
  debounceTimer = setTimeout(async () => {
    try {
      // Your own tags first: they answer in a few ms, while the booru top-up
      // can take seconds. The boorus are only asked when few local tags match.
      const url = `${instanceUrl}/api/tags/autocomplete?q=${encodeURIComponent(word)}`
      const res = await NekoAuth.authFetch(url)
      if (!res.ok || seq !== suggestSeq) return
      const local = await res.json()
      if (seq !== suggestSeq) return
      currentSuggestions = local
      selectedIndex = -1
      renderSuggestions()
      if (local.length >= 10) return
      const remoteRes = await NekoAuth.authFetch(`${url}&includeRemote=true`)
      if (!remoteRes.ok || seq !== suggestSeq) return
      const merged = await remoteRes.json()
      // The server keeps local rows first, so a highlighted row stays put.
      if (seq !== suggestSeq || merged.length <= local.length) return
      currentSuggestions = merged
      renderSuggestions()
    } catch {
      if (seq === suggestSeq) hideSuggestions()
    }
    // Long enough that a normal typing run costs a request per pause rather
    // than per keystroke - these queries can reach public boorus, which is not
    // a budget to spend one character at a time.
  }, 300)
}

function renderSuggestions() {
  els.suggestions.innerHTML = ''
  if (!currentSuggestions.length) {
    hideSuggestions()
    return
  }
  currentSuggestions.forEach((tag, index) => {
    const li = document.createElement('li')
    li.className = index === selectedIndex ? 'selected' : ''
    if (tag.categoryColor) li.style.borderLeftColor = tag.categoryColor
    const name = document.createElement('span')
    name.className = 'tag-name'
    name.textContent = tag.name
    const count = document.createElement('span')
    count.className = 'tag-count'
    if (tag.remote) {
      // Not in the library: show whose count it is, since it is not yours.
      name.append(Object.assign(document.createElement('em'), {
        className: 'tag-category',
        textContent: tag.category || '',
      }))
      count.classList.add('remote')
      count.textContent = `${tag.source} ${formatRemoteCount(tag.remoteCount)}`
      count.title = `Not in your library. ${tag.remoteCount} posts on ${tag.source}.`
    } else {
      count.textContent = tag.usageCount ?? ''
    }
    li.append(name, count)
    li.addEventListener('mousedown', (e) => {
      e.preventDefault()
      pickSuggestion(tag)
    })
    els.suggestions.appendChild(li)
  })
  els.suggestions.classList.remove('hidden')
}

function formatRemoteCount(count) {
  const value = Number(count) || 0
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function pickSuggestion(tag) {
  // A remote tag brings its category with it; the library has never seen it,
  // so this is the only chance to file it as a character rather than general.
  if (tag.remote && tag.name) {
    knownTagCategories[tag.name] = tag.category || 'general'
    if (tag.displayName && tag.displayName !== tag.name) knownTagDisplayNames[tag.name] = tag.displayName
  }
  // Suggestion names come from the server already normalised.
  if (!tags.includes(tag.name)) {
    tags.push(tag.name)
    renderPills()
  }
  els.tags.value = ''
  hideSuggestions()
  els.tags.focus()
}

function hideSuggestions() {
  currentSuggestions = []
  selectedIndex = -1
  els.suggestions.classList.add('hidden')
}

function onTagKeydown(e) {
  // Backspace on an empty input removes the last pill.
  if (e.key === 'Backspace' && !els.tags.value && tags.length) {
    e.preventDefault()
    removeTag(tags[tags.length - 1])
    return
  }

  const hasSuggestions =
    !els.suggestions.classList.contains('hidden') && currentSuggestions.length

  if (e.key === 'Enter') {
    e.preventDefault()
    if (hasSuggestions && selectedIndex >= 0) {
      pickSuggestion(currentSuggestions[selectedIndex])
    } else {
      commitInput()
    }
    return
  }

  if (!hasSuggestions) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex = (selectedIndex + 1) % currentSuggestions.length
    renderSuggestions()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex = selectedIndex <= 0 ? currentSuggestions.length - 1 : selectedIndex - 1
    renderSuggestions()
  } else if (e.key === 'Escape') {
    hideSuggestions()
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function parseTags() {
  // Fold any half-typed tag still sitting in the input into the pill list.
  commitInput()
  const tweetTag = twitterPostTag()
  if (els.includeTweetTag.checked && tweetTag && !tags.includes(tweetTag)) {
    tags.push(tweetTag)
  }
  const booruTag = booruPostTag()
  if (els.includeTweetTag.checked && booruTag && !tags.includes(booruTag)) {
    tags.push(booruTag)
  }
  const usernameTag = twitterUsernameTag()
  if (els.includeTweetUsername.checked && usernameTag && !tags.includes(usernameTag)) {
    tags.push(usernameTag)
  }
  // A handle, not a subject: file it under "user" so it groups with other
  // social accounts instead of disappearing into the general pile.
  if (usernameTag) knownTagCategories[usernameTag] = 'user'
  renderPills()
  return [...tags]
}
