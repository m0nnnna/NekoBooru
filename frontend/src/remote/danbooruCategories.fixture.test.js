import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  DANBOORU_CATEGORY_BATCH,
  DANBOORU_CATEGORY_TIMEOUT_MS,
  DANBOORU_CATEGORY_TTL_MS,
  createDanbooruCategoryResolver,
  danbooruCategoriesUrl,
  danbooruCategoryName,
} from './danbooruCategories.js'

// The shared cases in browser-extension/danbooru-categories.fixture.json. The
// extension's copy of this lookup (browser-extension/danbooru-categories.js)
// runs the same file, so the two cannot drift apart silently.
const fixture = JSON.parse(readFileSync(new URL('../../../browser-extension/danbooru-categories.fixture.json', import.meta.url), 'utf8'))

const BASE_CLOCK = 1_000_000

function fakeDanbooru(known, statuses = []) {
  const requests = []
  const fetch = async (url) => {
    const names = new URL(url).searchParams.get('search[name_comma]').split(',')
    const status = statuses[requests.length] ?? 200
    requests.push(names)
    const body = status === 200 ? names.filter((name) => name in known).map((name) => ({ name, category: known[name] })) : []
    return { ok: status === 200, status, headers: new Headers(), json: async () => body }
  }
  return { fetch, requests }
}

function memoryStorage() {
  const data = {}
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) },
  }
}

const caseNames = (entry) => entry.names || Array.from({ length: entry.generate }, (_, i) => `tag_${i}`)

describe('danbooruCategories shared fixture', () => {
  it('uses the shared batch size, cache lifetime, timeout, category map and URL', () => {
    expect(DANBOORU_CATEGORY_BATCH).toBe(fixture.batchSize)
    expect(DANBOORU_CATEGORY_TTL_MS).toBe(fixture.ttlMs)
    expect(DANBOORU_CATEGORY_TIMEOUT_MS).toBe(fixture.timeoutMs)
    for (const [value, name] of fixture.categoryNames) expect(danbooruCategoryName(value)).toBe(name)
    expect(danbooruCategoriesUrl(fixture.url.names)).toBe(fixture.url.expected)
  })

  for (const entry of fixture.resolveCases) {
    it(entry.name, async () => {
      const danbooru = fakeDanbooru(entry.known, entry.statuses)
      const resolver = createDanbooruCategoryResolver({ fetch: danbooru.fetch, storage: memoryStorage(), now: () => BASE_CLOCK })
      const answer = await resolver.resolve(caseNames(entry))
      expect(danbooru.requests.map((names) => names.length)).toEqual(entry.requests)
      if (entry.expectedCount === undefined) {
        expect(answer).toEqual(entry.expected)
      } else {
        expect(Object.keys(answer)).toHaveLength(entry.expectedCount)
        for (const [name, category] of Object.entries(entry.expected)) expect(answer[name]).toBe(category)
      }
    })
  }

  it('keeps answers for the shared cache lifetime', async () => {
    let clock = BASE_CLOCK
    const resolver = createDanbooruCategoryResolver({ fetch: null, storage: memoryStorage(), now: () => clock })
    for (const step of fixture.cacheSteps) {
      const danbooru = fakeDanbooru(fixture.cacheKnown)
      clock = BASE_CLOCK + step.atMs
      const original = globalThis.fetch
      globalThis.fetch = danbooru.fetch
      try {
        expect(await resolver.resolve(fixture.cacheNames), step.name).toEqual(step.expected)
      } finally {
        globalThis.fetch = original
      }
      expect(danbooru.requests.length, step.name).toBe(step.requests)
    }
  })
})
