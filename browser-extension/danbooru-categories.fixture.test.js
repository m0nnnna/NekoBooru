const assert = require('node:assert/strict')
const categories = require('./danbooru-categories.js')
const fixture = require('./danbooru-categories.fixture.json')

// Run with: node browser-extension/danbooru-categories.fixture.test.js
// The shared cases in danbooru-categories.fixture.json; the web app's copy
// (frontend/src/remote/danbooruCategories.js) runs the same file in
// frontend/src/remote/danbooruCategories.fixture.test.js.

const BASE_CLOCK = 1_000_000

function fakeDanbooru(known, statuses = []) {
  const requests = []
  const fetch = async (url) => {
    const names = new URL(url).searchParams.get('search[name_comma]').split(',')
    const status = statuses[requests.length] ?? 200
    requests.push(names)
    if (status !== 200) return { ok: false, status, json: async () => [] }
    return { ok: true, status, json: async () => names.filter((name) => name in known).map((name) => ({ name, category: known[name] })) }
  }
  return { fetch, requests }
}

function fakeStorage() {
  const data = {}
  return {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (values) => { Object.assign(data, values) },
  }
}

const caseNames = (entry) => entry.names || Array.from({ length: entry.generate }, (_, i) => `tag_${i}`)

;(async () => {
  assert.equal(categories.DANBOORU_CATEGORY_BATCH, fixture.batchSize)
  assert.equal(categories.DANBOORU_CATEGORY_TTL_MS, fixture.ttlMs)
  assert.equal(categories.DANBOORU_CATEGORY_TIMEOUT_MS, fixture.timeoutMs)
  for (const [value, name] of fixture.categoryNames) assert.equal(categories.danbooruCategoryName(value), name, `category ${value}`)
  assert.equal(categories.danbooruCategoriesUrl(fixture.url.names), fixture.url.expected)

  for (const entry of fixture.resolveCases) {
    const danbooru = fakeDanbooru(entry.known, entry.statuses)
    const answer = await categories.resolveDanbooruCategories(caseNames(entry), {
      fetch: danbooru.fetch,
      storage: fakeStorage(),
      now: () => BASE_CLOCK,
    })
    assert.deepEqual(danbooru.requests.map((names) => names.length), entry.requests, entry.name)
    if (entry.expectedCount !== undefined) assert.equal(Object.keys(answer).length, entry.expectedCount, entry.name)
    if (entry.expectedCount === undefined) assert.deepEqual(answer, entry.expected, entry.name)
    else for (const [name, category] of Object.entries(entry.expected)) assert.equal(answer[name], category, `${entry.name}: ${name}`)
  }

  const storage = fakeStorage()
  for (const step of fixture.cacheSteps) {
    const danbooru = fakeDanbooru(fixture.cacheKnown)
    const answer = await categories.resolveDanbooruCategories(fixture.cacheNames, {
      fetch: danbooru.fetch,
      storage,
      now: () => BASE_CLOCK + step.atMs,
    })
    assert.equal(danbooru.requests.length, step.requests, step.name)
    assert.deepEqual(answer, step.expected, step.name)
  }

  console.log('danbooru-categories fixture tests passed')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
