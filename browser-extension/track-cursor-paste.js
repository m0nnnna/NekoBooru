// Content script, part of track-cursor.js: pasting media from NekoBooru into
// the page - finding the editable target or composer, then a synthetic
// paste/drop or the composer's own file input.
//
// Plain script sharing the content script's scope; listed before
// track-cursor.js in manifest.json and in background.js's re-injection.

const EDITABLE_SELECTOR = 'textarea, input, [contenteditable="true"], [role="textbox"]'

// composedPath() sees through shadow DOM, where event.target is only the host.
function editableTargetFromEvent(event) {
  for (const el of event.composedPath?.() || []) {
    if (el?.matches?.(EDITABLE_SELECTOR)) return el
  }
  return event.target?.closest?.(EDITABLE_SELECTOR) || null
}

// Shadow-DOM-aware helpers: a component page (X's chat) keeps its composer in
// shadow roots that document.querySelector and parentElement cannot cross.
function parentAcrossShadow(node) {
  if (node?.parentElement) return node.parentElement
  const root = node?.parentNode
  return root instanceof ShadowRoot ? root.host : null
}

function deepQueryAll(selector, root = document) {
  const found = [...root.querySelectorAll(selector)]
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) found.push(...deepQueryAll(selector, el.shadowRoot))
  }
  return found
}

function deepActiveElement() {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

function deepElementsUnder(x, y) {
  const stack = elementsUnder(x, y)
  const top = stack[0]
  if (top?.shadowRoot?.elementsFromPoint) {
    try {
      return [...top.shadowRoot.elementsFromPoint(x, y), ...stack]
    } catch {
      return stack
    }
  }
  return stack
}

// Each way of handing a file to a page is tried in turn, and one only counts
// once a new preview appears. X redesigns its composers (the DM chat most
// recently), and every method can be accepted silently while doing nothing.
async function pasteFileIntoEditable(file) {
  const target = resolveEditableTarget()
  if (!target) return { ok: false, error: `No text box found to insert into (${pageDiagnostics()}).` }

  const attempts = []
  if (isXHost()) attempts.push(['file-input', () => attachFileViaInput(target, file)])
  attempts.push(['paste', () => dispatchFileEvent(target, file, 'paste')])
  attempts.push(['drop', () => dispatchFileEvent(target, file, 'drop')])

  const scope = composerScope(target)
  const tried = []
  for (const [method, attempt] of attempts) {
    const before = previewCount(scope)
    const result = attempt()
    if (!result.ok) {
      tried.push(`${method}: ${result.error}`)
      continue
    }
    if (await previewAppeared(scope, before)) return { ...result, method, verified: true }
    tried.push(`${method}: no preview appeared`)
  }
  return { ok: false, error: `The page did not take the file (${tried.join('; ')}; target: ${describeElement(target)}).` }
}

const X_COMPOSER_TEXT_BOXES = '[data-testid="dm-composer-textarea"], [data-testid^="tweetTextarea_"]'

// Where to insert, found again now rather than trusted from the right-click:
// the picker takes focus, and X re-renders its chat box when the window
// blurs, which leaves the remembered element detached (or the focus elsewhere).
function resolveEditableTarget() {
  const candidates = []
  if (lastEditableTarget?.isConnected) candidates.push(lastEditableTarget)
  for (const el of deepElementsUnder(lastContextMenuPoint.x, lastContextMenuPoint.y)) {
    const editable = el.closest?.(EDITABLE_SELECTOR)
    if (editable) {
      candidates.push(editable)
      break
    }
  }
  if (isXHost()) candidates.push(...deepQueryAll(X_COMPOSER_TEXT_BOXES))
  const active = deepActiveElement()
  if (active && active !== document.body && active.matches?.(EDITABLE_SELECTOR)) candidates.push(active)

  const usable = candidates.filter((el) => el?.isConnected && isVisible(el))
  // On X the right box is the one with X's own attach input around it, then
  // any box with an attach input; a stray box (the search field) has neither.
  if (isXHost()) {
    const withKnownInput = usable.find((el) => findFileInputForTarget(el, null)?.matches(X_COMPOSER_FILE_INPUTS))
    if (withKnownInput) return withKnownInput
    const withInput = usable.find((el) => findFileInputForTarget(el, null))
    if (withInput) return withInput
  }
  return usable[0] || null
}

// Enough to tell a wrong frame, a shadow-DOM page, or a renamed composer apart.
function pageDiagnostics() {
  const shadowHosts = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).length
  return [
    window === window.top ? 'top frame' : 'iframe',
    location.pathname,
    `${shadowHosts} shadow roots`,
    `${deepQueryAll(X_COMPOSER_TEXT_BOXES).length} X composer boxes`,
    `${deepQueryAll('textarea').length} textareas`,
    `remembered: ${lastEditableTarget ? (lastEditableTarget.isConnected ? describeElement(lastEditableTarget) : 'detached') : 'none'}`,
  ].join(', ')
}

function isVisible(el) {
  const rect = el.getBoundingClientRect?.()
  return !!rect && rect.width > 0 && rect.height > 0
}

function describeElement(el) {
  const testId = el.getAttribute?.('data-testid')
  return `${(el.tagName || '?').toLowerCase()}${testId ? `[${testId}]` : ''}`
}

function dispatchFileEvent(target, file, type) {
  try {
    target.focus?.()
  } catch {
    // Some page-controlled elements reject focus; still try the event.
  }
  const data = new DataTransfer()
  data.items.add(file)
  try {
    if (type === 'paste') {
      target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    } else {
      for (const name of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: data }))
      }
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
  return { ok: true, files: data.files.length }
}

// The area an attachment preview would appear in: the nearest container around
// the text box that holds a file input, else a few levels up from it.
function composerScope(target) {
  let node = target
  let fallback = target
  for (let depth = 0; node && node !== document.body && depth < 15; depth += 1) {
    if (deepQueryAll('input[type="file"]', node).length) return node
    if (depth === 6) fallback = node
    node = parentAcrossShadow(node)
  }
  return parentAcrossShadow(fallback) || document.body
}

// Any new image, video or canvas in the composer counts as a preview (X's are
// not always object URLs), plus object-URL media anywhere on the page.
function previewCount(scope) {
  const local = deepQueryAll('img, video, canvas, [style*="background-image"]', scope).length
  const page = deepQueryAll('img[src^="blob:"], video[src^="blob:"], [style*="blob:"]').length
  return local + page
}

async function previewAppeared(scope, before, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (previewCount(scope) > before) return true
  }
  return false
}

// X's composers name their attach inputs; the DM chat's sits above the
// message form rather than inside it.
const X_COMPOSER_FILE_INPUTS = '[data-testid="dm-composer-file-input"], [data-testid="fileInput"]'

function attachFileViaInput(target, file) {
  const input = findFileInputForTarget(target, file)
  if (!input) return { ok: false, error: 'No file input in this composer.' }

  const data = new DataTransfer()
  data.items.add(file)
  input.files = data.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))

  return {
    ok: true,
    files: input.files.length,
    method: 'file-input',
  }
}

// The nearest container around the text box that holds a file input, never a
// page-wide search: that used to pick an unrelated input elsewhere on the page
// (X's new chat composer keeps its own), report success, and attach nothing.
function findFileInputForTarget(target, file) {
  let node = target
  for (let depth = 0; node && node !== document.body && depth < 15; depth += 1) {
    const inputs = deepQueryAll('input[type="file"]', node).filter((input) => !input.disabled)
    if (inputs.length) {
      return inputs.find((input) => input.matches(X_COMPOSER_FILE_INPUTS))
        || inputs.sort((a, b) => fileInputScore(b, file) - fileInputScore(a, file))[0]
    }
    node = parentAcrossShadow(node)
  }
  return null
}

function fileInputScore(input, file) {
  const accept = (input.getAttribute('accept') || '').toLowerCase()
  const name = (file?.name || '').toLowerCase()
  const type = (file?.type || '').toLowerCase()
  let score = 0
  if (input.multiple) score += 1
  if (!accept) score += 1
  if (accept.includes(type)) score += 10
  if (type.startsWith('video/') && accept.includes('video')) score += 8
  if (type.startsWith('image/') && accept.includes('image')) score += 8
  if (name.endsWith('.mp4') && accept.includes('.mp4')) score += 6
  if (name.endsWith('.webm') && accept.includes('.webm')) score += 6
  if (name.endsWith('.gif') && accept.includes('.gif')) score += 6
  return score
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'nekobooru-paste-media-file') return
  ;(async () => {
    try {
      const blob = await dataUrlToBlob(msg.dataUrl)
      const file = new File([blob], msg.filename || 'nekobooru-media', {
        type: msg.mime || blob.type || 'application/octet-stream',
      })
      const result = await pasteFileIntoEditable(file)
      sendResponse({
        ...result,
        fileSize: file.size,
        expectedSize: msg.size || null,
      })
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) })
    }
  })()
  return true
})

async function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new Error('No media bytes were received.')
  }
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error('Could not decode media bytes.')
  return response.blob()
}
