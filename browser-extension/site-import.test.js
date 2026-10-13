const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const fixture = require('./booru-import-rules.fixture.json')

// Run with: node browser-extension/site-import.test.js
// Drives the import page (site-import.html and its scripts, loaded in the
// order the page loads them) against a fake NekoBooru, for the shared cases
// in booru-import-rules.fixture.json. The web app's import queue runs the
// same file in frontend/src/remote/useImportQueue.fixture.test.js.

const INSTANCE = 'http://neko.test'
const PAGE_SCRIPTS = [...fs.readFileSync(path.join(__dirname, 'site-import.html'), 'utf8')
  .matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((file) => file !== 'neko-auth.js')

class FakeElement {
  constructor(tagName, onFinal = null) {
    this.tagName = tagName
    this.children = []
    this.style = {}
    this.dataset = {}
    this.classList = { add() {}, remove() {} }
    this.texts = []
    this.text = ''
    this.kind = ''
    this.onFinal = onFinal
  }

  get textContent() { return this.text }
  set textContent(value) {
    this.text = String(value)
    this.texts.push(this.text)
  }

  get className() { return this.kind }
  set className(value) {
    this.kind = value
    if (this.onFinal && (value === 'error' || value === 'success')) this.onFinal()
  }

  set innerHTML(_value) { this.children = [] }
  appendChild(child) { this.children.push(child); return child }
  append(...children) { this.children.push(...children) }
  querySelector(selector) { return this.children.find((child) => child.tagName === selector) || null }
  querySelectorAll() { return [] }
  addEventListener() {}
}

const ok = (body) => ({ status: 200, body })

function fakeBackend(routes) {
  return (method, url, body) => {
    const { pathname, searchParams } = new URL(url)
    if (pathname === '/api/health') return ok({ status: 'ok' })
    if (pathname.startsWith('/api/uploads/from-url/progress/')) return ok({ received: 0, total: 0 })
    if (pathname === '/api/uploads/from-url') return routes.fromUrl(body)
    if (method === 'GET' && pathname === '/api/posts') return routes.search?.(searchParams.get('q')) || ok({ results: [] })
    if (method === 'POST' && pathname === '/api/posts') return routes.createPost(body)
    const restore = pathname.match(/^\/api\/posts\/(\d+)\/restore$/)
    if (method === 'POST' && restore) return routes.restore(Number(restore[1]))
    if (method === 'PUT' && /^\/api\/posts\/\d+$/.test(pathname)) return ok({})
    return { status: 404, body: { detail: `No fake route for ${method} ${pathname}` } }
  }
}

// Runs one import job through the page. Resolves with every request the page
// made, the waits it scheduled (download progress polls aside) and its rows.
async function runImport(job, routes) {
  const requests = []
  const sleeps = []
  let finish
  const finished = new Promise((resolve) => { finish = resolve })
  const elements = {}
  const backend = fakeBackend(routes)
  const context = {
    console,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    location: { search: '?job=job-1' },
    document: {
      getElementById: (id) => (elements[id] ||= new FakeElement('div', id === 'status' ? () => finish() : null)),
      createElement: (tagName) => new FakeElement(tagName),
    },
    setTimeout: (callback, ms) => {
      // The progress poll (1 s) never fires; every other wait is recorded and
      // skipped.
      if (ms === 1000) return 0
      sleeps.push(ms)
      setImmediate(callback)
      return 0
    },
    clearTimeout: () => {},
    chrome: {
      storage: {
        sync: { get: async () => ({ instanceUrl: INSTANCE }) },
        local: { get: async (key) => ({ [key]: job }), remove: async () => {} },
      },
      runtime: { sendMessage: async () => {}, openOptionsPage() {} },
      notifications: { create() {} },
    },
    NekoAuth: {
      authFetch: async (url, options = {}) => {
        const method = options.method || 'GET'
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : null
        requests.push({ method, path: new URL(url).pathname, body })
        const answer = backend(method, url, body)
        return { ok: answer.status < 300, status: answer.status, json: async () => answer.body }
      },
    },
  }
  context.globalThis = context
  vm.createContext(context)
  for (const file of PAGE_SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file })
  }
  await Promise.race([
    finished,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`import did not finish: ${elements.status?.text}`)), 2000)),
  ])
  const rows = (elements.items?.children || []).map((row) => ({
    state: row.className,
    texts: row.querySelector('strong').texts,
  }))
  return { requests, sleeps, rows, status: elements.status?.text }
}

function mediaFor(postId, extra = {}) {
  return {
    type: 'image',
    url: `https://cdn.donmai.test/original/${postId}.png`,
    referer: 'https://danbooru.donmai.us/',
    postId,
    label: `Danbooru #${postId}`,
    safety: 'safe',
    tags: [`danbooru_${postId}`],
    tagCategories: { [`danbooru_${postId}`]: 'meta' },
    tagDisplayNames: {},
    source: `https://danbooru.donmai.us/posts/${postId}`,
    ...extra,
  }
}

function singleJob(postId, item) {
  return {
    kind: 'danbooru',
    postId,
    title: `Danbooru #${postId}`,
    canonicalUrl: `https://danbooru.donmai.us/posts/${postId}`,
    groupTag: `danbooru_${postId}`,
    media: [{ ...mediaFor(postId, item), index: 0 }],
  }
}

function searchJob(media) {
  return {
    kind: 'danbooru_search',
    postId: '1girl|1',
    title: 'Danbooru: 1girl',
    canonicalUrl: 'https://danbooru.donmai.us/posts?tags=1girl&page=1',
    groupTag: '1girl',
    unavailable: [],
    media: media.map((item, index) => ({ ...item, index })),
  }
}

const tests = []
const test = (name, run) => tests.push({ name, run })

test('pacing constants and Retry-After hints', () => {
  const rules = require('./booru-import-rules.js')
  assert.equal(rules.DOWNLOAD_GAP_MS, fixture.pacing.downloadGapMs)
  assert.deepEqual(rules.RETRY_DELAYS_MS, fixture.pacing.retryDelaysMs)
  assert.equal(rules.MAX_THROTTLE_WAIT_MS, fixture.pacing.maxThrottleWaitMs)
  // The extension's errors carry the status in their text only; the hints
  // reach the web app, and the rule is the same one.
  for (const entry of fixture.throttleHints) {
    assert.equal(rules.throttleDelayMs(entry.error, entry.attempt), entry.expectedMs, entry.name)
  }
})

test('every script list loads the rules before site-import-shared.js', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'))
  const background = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8')
  const importScripts = background.match(/importScripts\(([^)]*site-import-shared\.js[^)]*)\)/)[1]
    .split(',').map((file) => file.trim().replace(/^'|'$/g, ''))
  const lists = [
    PAGE_SCRIPTS,
    importScripts,
    ...manifest.content_scripts.map((entry) => entry.js).filter((files) => files.includes('site-import-shared.js')),
  ]
  assert.equal(lists.length, 4)
  for (const files of lists) {
    assert.ok(files.indexOf('booru-import-rules.js') >= 0, files.join(', '))
    assert.ok(files.indexOf('booru-import-rules.js') < files.indexOf('site-import-shared.js'), files.join(', '))
  }
})

test('download progress text', () => {
  const { downloadProgressText } = require('./site-import-core.js')
  for (const entry of fixture.progressText) {
    assert.equal(downloadProgressText(entry.progress, entry.elapsedMs), entry.expected)
  }
})

test('tag display names', () => {
  const { booruDisplayNames } = require('./site-import-shared.js')
  for (const entry of fixture.displayNames) {
    const names = booruDisplayNames([entry.tag])
    assert.deepEqual(names, entry.display === null ? {} : { [entry.tag]: entry.display }, entry.tag)
  }
})

for (const entry of fixture.postBody) {
  test(`post body: ${entry.name}`, async () => {
    const { requests } = await runImport(singleJob(entry.postId, entry.import), {
      fromUrl: () => ok({ token: entry.contentToken }),
      createPost: () => ok({ id: 100 }),
    })
    const create = requests.find((request) => request.method === 'POST' && request.path === '/api/posts')
    assert.deepEqual(create.body, { ...entry.expected, autoTag: false, autoTagProfile: 'gelbooru_import' })
  })
}

for (const entry of fixture.merge) {
  test(`merge: ${entry.name}`, async () => {
    const restores = []
    const { requests, rows } = await runImport(singleJob(entry.postId, entry.import), {
      fromUrl: () => ok({ token: 'tok' }),
      createPost: () => ({ status: 409, body: { detail: { code: 'duplicate_post', ...entry.duplicate } } }),
      restore: (id) => { restores.push(id); return ok(entry.restored) },
    })
    assert.deepEqual(restores, entry.restored ? [entry.duplicate.postId] : [])
    const put = requests.find((request) => request.method === 'PUT')
    assert.equal(put.path, `/api/posts/${entry.duplicate.postId}`)
    assert.deepEqual(put.body, entry.expected)
    assert.equal(rows[0].state, 'done')
  })
}

for (const entry of fixture.pacingRuns) {
  test(`pacing: ${entry.name}`, async () => {
    const inLibrary = new Set(entry.posts.filter((post) => post.inLibrary).map((post) => `danbooru_${post.postId}`))
    const { requests, sleeps, rows } = await runImport(searchJob(entry.posts.map((post) => mediaFor(post.postId))), {
      search: (q) => (inLibrary.has(q) ? ok({ results: [{ id: 50, tags: [q], safety: 'safe', source: '' }] }) : null),
      fromUrl: () => ok({ token: 'tok' }),
      createPost: () => ok({ id: 100 }),
    })
    assert.deepEqual(sleeps, entry.expectedSleepsMs)
    assert.equal(requests.filter((request) => request.path === '/api/uploads/from-url').length, entry.posts.length - inLibrary.size)
    assert.deepEqual(rows.map((row) => row.state), entry.posts.map(() => 'done'))
  })
}

for (const entry of fixture.throttle) {
  test(`throttle: ${entry.name}`, async () => {
    let calls = 0
    const { sleeps, rows } = await runImport(searchJob([mediaFor('21')]), {
      fromUrl: () => {
        const failure = entry.failures[calls++]
        return failure ? { status: 502, body: { detail: failure } } : ok({ token: 'tok' })
      },
      createPost: () => ok({ id: 100 }),
    })
    assert.deepEqual(sleeps, entry.expectedSleepsMs)
    assert.deepEqual(rows[0].texts.filter((text) => text.includes('slow down')), entry.expectedRetryTexts)
    assert.equal(rows[0].state, entry.outcome === 'imported' ? 'done' : 'failed')
    if (entry.finalMessage) assert.equal(rows[0].texts.at(-1), entry.finalMessage)
  })
}

;(async () => {
  for (const { name, run } of tests) {
    try {
      await run()
    } catch (error) {
      console.error(`FAIL ${name}`)
      throw error
    }
  }
  console.log(`site-import.test.js: ${tests.length} passed`)
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
