const assert = require('node:assert/strict')
const categories = require('./danbooru-categories.js')

// Run with: node browser-extension/danbooru-categories.test.js
// Every Danbooru response here is a fake; nothing touches the network.

function fakeDanbooru(known = {}) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init })
    const names = new URL(url).searchParams.get('search[name_comma]').split(',')
    const rows = names.filter((name) => name in known).map((name) => ({ name, category: known[name] }))
    return { ok: true, status: 200, json: async () => rows }
  }
  return { fetch, calls }
}

function fakeStorage() {
  const data = {}
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (values) => { Object.assign(data, values) },
  }
}

function safebooruJob(tags, tagCategories = {}) {
  return {
    kind: 'safebooru',
    postId: '55',
    groupTag: 'safebooru_55',
    media: [{ tags: [...tags, 'safebooru_55'], tagCategories: { ...tagCategories, safebooru_55: 'meta' } }],
  }
}

async function main() {
  assert.deepEqual([0, 1, 3, 4, 5, 2].map(categories.danbooruCategoryName), ['general', 'artist', 'copyright', 'character', 'meta', 'general'])
  const url = new URL(categories.danbooruCategoriesUrl(['a', 'miyu_(blue_archive)']))
  assert.equal(url.origin + url.pathname, 'https://danbooru.donmai.us/tags.json')
  assert.equal(url.searchParams.get('search[name_comma]'), 'a,miyu_(blue_archive)')
  assert.equal(url.searchParams.get('only'), 'name,category')
  assert.equal(url.searchParams.get('limit'), '2')

  // 80 names per request; unknown names come back general.
  {
    const names = Array.from({ length: 170 }, (_, index) => `tag_${index}`)
    const danbooru = fakeDanbooru({ tag_0: 1, tag_100: 4 })
    const answer = await categories.resolveDanbooruCategories(names, { fetch: danbooru.fetch, storage: null })
    assert.deepEqual(danbooru.calls.map((call) => call.url.searchParams.get('search[name_comma]').split(',').length), [80, 80, 10])
    assert.equal(danbooru.calls[0].init.credentials, 'omit')
    assert.equal(answer.tag_0, 'artist')
    assert.equal(answer.tag_100, 'character')
    assert.equal(answer.tag_1, 'general')
    assert.equal(Object.keys(answer).length, 170)
  }

  // Cached a day in storage, then asked again.
  {
    const storage = fakeStorage()
    const danbooru = fakeDanbooru({ templus: 1 })
    let clock = 1000
    const options = { fetch: danbooru.fetch, storage, now: () => clock }
    assert.deepEqual(await categories.resolveDanbooruCategories(['templus'], options), { templus: 'artist' })
    assert.deepEqual(storage.data[categories.DANBOORU_CATEGORY_STORAGE_KEY], { templus: ['artist', 1000] })
    clock += categories.DANBOORU_CATEGORY_TTL_MS - 1
    assert.deepEqual(await categories.resolveDanbooruCategories(['templus'], options), { templus: 'artist' })
    assert.equal(danbooru.calls.length, 1)
    clock += 1
    await categories.resolveDanbooruCategories(['templus'], options)
    assert.equal(danbooru.calls.length, 2)
  }

  // Failures leave the tags out (they stay general) and never throw.
  {
    const failing = async () => { throw new TypeError('Failed to fetch') }
    assert.deepEqual(await categories.resolveDanbooruCategories(['templus'], { fetch: failing, storage: null }), {})
    let throttled = 0
    const tooMany = async () => { throttled += 1; return { ok: false, status: 429, json: async () => ({}) } }
    const many = Array.from({ length: 200 }, (_, index) => `t${index}`)
    assert.deepEqual(await categories.resolveDanbooruCategories(many, { fetch: tooMany, storage: null }), {})
    assert.equal(throttled, 1)
    const hanging = (input, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    assert.deepEqual(await categories.resolveDanbooruCategories(['templus'], { fetch: hanging, storage: null, timeoutMs: 10 }), {})
  }

  // A Safebooru job: general tags take Danbooru's category, the page's own
  // categories and the id tag stay, a failure leaves the job untouched.
  {
    const danbooru = fakeDanbooru({ templus: 1, 'miyu_(blue_archive)': 4, blue_archive: 3, safebooru_55: 0 })
    const job = safebooruJob(['templus', 'miyu_(blue_archive)', 'blue_archive', 'solo'], { blue_archive: 'artist' })
    await categories.applyDanbooruCategories(job, { fetch: danbooru.fetch, storage: null })
    assert.deepEqual(job.media[0].tagCategories, {
      templus: 'artist',
      'miyu_(blue_archive)': 'character',
      blue_archive: 'artist',
      solo: 'general',
      safebooru_55: 'meta',
    })
    assert.deepEqual(danbooru.calls[0].url.searchParams.get('search[name_comma]').split(','), ['templus', 'miyu_(blue_archive)', 'solo'])

    const failed = safebooruJob(['templus'])
    await categories.applyDanbooruCategories(failed, { fetch: async () => { throw new Error('offline') }, storage: null })
    assert.deepEqual(failed.media[0].tagCategories, { safebooru_55: 'meta' })
  }

  // Only Safebooru jobs are looked up.
  {
    const danbooru = fakeDanbooru({ templus: 1 })
    const job = { kind: 'gelbooru', groupTag: 'gelbooru_1', media: [{ tags: ['templus'], tagCategories: {} }] }
    await categories.applyDanbooruCategories(job, { fetch: danbooru.fetch, storage: null })
    assert.equal(danbooru.calls.length, 0)
    assert.deepEqual(job.media[0].tagCategories, {})
  }

  console.log('danbooru-categories tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
