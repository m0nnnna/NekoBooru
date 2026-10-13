import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NAME_CACHE_MS,
  cachedNameResolver,
  e621Candidates,
  librarySpellingResolver,
  lookupE621Name,
  mapPlainTerms,
  swappedName,
} from './e621Names.js'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Answers e621's tags.json / tag_aliases.json and Danbooru's alias search by URL.
function fakeBooru({ counts = {}, aliases = {}, expansions = {}, status = 200 } = {}) {
  return vi.fn(async (input) => {
    const url = new URL(input)
    const params = Object.fromEntries(url.searchParams)
    if (url.hostname === 'danbooru.donmai.us') {
      const name = params['search[antecedent_name]']
      return json((expansions[name] || []).map((longer) => ({ antecedent_name: name, consequent_name: longer })))
    }
    if (status !== 200) return json({}, status)
    if (url.pathname === '/tag_aliases.json') {
      const name = params['search[antecedent_name]']
      return json(aliases[name] ? [{ antecedent_name: name, consequent_name: aliases[name] }] : { tag_aliases: [] })
    }
    const rows = params['search[name]'].split(',').filter((name) => name in counts).map((name) => ({ name, post_count: counts[name] }))
    return json(rows.length ? rows : { tags: [] })
  })
}

function memoryStorage() {
  const data = new Map()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), data }
}

describe('candidates', () => {
  it('swaps two-part names and keeps the qualifier', () => {
    expect(swappedName('hirasawa_yui')).toBe('yui_hirasawa')
    expect(swappedName('yui_hirasawa_(k-on!)')).toBe('hirasawa_yui_(k-on!)')
    expect(swappedName('saber')).toBeNull()
    expect(swappedName('honoka_(doa)')).toBeNull()
  })

  it('lists the spelling, alias, swap and expanded qualifiers once each', () => {
    expect(e621Candidates('yoshizawa_kasumi_(p5)', 'kasumi_(p5)', ['persona_5'])).toEqual([
      'yoshizawa_kasumi_(p5)',
      'kasumi_(p5)',
      'kasumi_yoshizawa_(p5)',
      'yoshizawa_kasumi_(persona_5)',
      'kasumi_yoshizawa_(persona_5)',
    ])
  })
})

describe('lookupE621Name', () => {
  it('picks the candidate with the most posts', async () => {
    const fetch = fakeBooru({ counts: { hirasawa_yui: 3, yui_hirasawa: 4000 } })
    expect(await lookupE621Name('hirasawa_yui', { fetch })).toBe('yui_hirasawa')
    const tagRequests = fetch.mock.calls.map(([url]) => new URL(url)).filter((url) => url.pathname === '/tags.json')
    expect(tagRequests).toHaveLength(1)
    expect(tagRequests[0].searchParams.get('_client')).toBe('NekoBooru/1.0')
  })

  it('uses e621 aliases and Danbooru qualifier expansions', async () => {
    expect(await lookupE621Name('akiyama_mio', { fetch: fakeBooru({ counts: { mio_akiyama_x: 5 }, aliases: { akiyama_mio: 'mio_akiyama_x' } }) })).toBe('mio_akiyama_x')
    expect(await lookupE621Name('honoka_(doa)', { fetch: fakeBooru({ counts: { 'honoka_(dead_or_alive)': 90 }, expansions: { doa: ['dead_or_alive'] } }) })).toBe('honoka_(dead_or_alive)')
  })

  it('keeps the spelling when nothing has posts and throws when e621 refuses', async () => {
    expect(await lookupE621Name('hirasawa_yui', { fetch: fakeBooru() })).toBe('hirasawa_yui')
    await expect(lookupE621Name('hirasawa_yui', { fetch: fakeBooru({ status: 429 }) })).rejects.toThrow('429')
  })
})

describe('cachedNameResolver', () => {
  let lookup
  let resolve
  beforeEach(() => {
    lookup = vi.fn(async () => 'yui_hirasawa')
    resolve = cachedNameResolver('test.names', lookup)
  })

  it('remembers answers in memory and localStorage for a day', async () => {
    const storage = memoryStorage()
    const now = () => 1000
    expect(await resolve('hirasawa_yui', { storage, now })).toBe('yui_hirasawa')
    expect(await resolve('hirasawa_yui', { storage, now })).toBe('yui_hirasawa')
    expect(lookup).toHaveBeenCalledTimes(1)

    // A fresh page (empty memory) reads localStorage.
    const reloaded = cachedNameResolver('test.names', lookup)
    expect(await reloaded('hirasawa_yui', { storage, now })).toBe('yui_hirasawa')
    expect(lookup).toHaveBeenCalledTimes(1)

    // A day later it asks again.
    expect(await reloaded('hirasawa_yui', { storage, now: () => 1000 + NAME_CACHE_MS })).toBe('yui_hirasawa')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('leaves a term unchanged on failure and does not cache it', async () => {
    lookup.mockRejectedValueOnce(new Error('offline'))
    const storage = memoryStorage()
    expect(await resolve('hirasawa_yui', { storage })).toBe('hirasawa_yui')
    expect(storage.data.size).toBe(0)
    expect(await resolve('hirasawa_yui', { storage })).toBe('yui_hirasawa')
  })

  it('works without storage', async () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(await resolve('hirasawa_yui', { storage: broken })).toBe('yui_hirasawa')
    expect(await resolve('hirasawa_yui', { storage: null })).toBe('yui_hirasawa')
  })
})

describe('mapPlainTerms', () => {
  it('maps only plain tags and names them in the note', async () => {
    const resolve = vi.fn(async (name) => (name === 'hirasawa_yui' ? 'yui_hirasawa' : name))
    const result = await mapPlainTerms('hirasawa_yui guitar -akiyama_mio fox*', ['hirasawa_yui', 'guitar', '-akiyama_mio', 'fox*'], resolve, 'e621')
    expect(result.terms).toEqual(['yui_hirasawa', 'guitar', '-akiyama_mio', 'fox*'])
    expect(result.note).toBe('Searched e621 as hirasawa_yui → yui_hirasawa')
    expect(resolve.mock.calls.map(([name]) => name)).toEqual(['hirasawa_yui', 'guitar'])
  })

  it('un-flattens a library tag through its display spelling before resolving it', async () => {
    const resolve = vi.fn(async (name) => (name === 'honoka_(doa)' ? 'honoka_(dead_or_alive)' : name))
    const librarySpelling = vi.fn(async (name) => (name === 'honoka_doa' ? 'honoka_(doa)' : name))
    const result = await mapPlainTerms('honoka_doa beach', ['honoka_doa', 'beach'], resolve, 'Sankaku', { librarySpelling })
    expect(resolve.mock.calls.map(([name]) => name)).toEqual(['honoka_(doa)', 'beach'])
    expect(result.terms).toEqual(['honoka_(dead_or_alive)', 'beach'])
    expect(result.note).toBe('Searched Sankaku as honoka_doa → honoka_(dead_or_alive)')
  })

  it('searches the un-flattened spelling when the booru has no other name for it', async () => {
    const librarySpelling = async (name) => (name === 'miyu_blue_archive' ? 'miyu_(blue_archive)' : name)
    const result = await mapPlainTerms('miyu_blue_archive', ['miyu_blue_archive'], async (name) => name, 'e621', { librarySpelling })
    expect(result.terms).toEqual(['miyu_(blue_archive)'])
  })
})

describe('librarySpellingResolver', () => {
  it("spells a stored tag as the boorus do, from the library's display name, once per tag", async () => {
    const api = { getTag: vi.fn(async (name) => ({ name, displayName: name === 'honoka_doa' ? 'honoka (doa)' : 'Something Else' })) }
    const spell = librarySpellingResolver(api)
    expect(await spell('honoka_doa')).toBe('honoka_(doa)')
    expect(await spell('honoka_doa')).toBe('honoka_(doa)')
    // A display name that does not flatten back to the tag changes nothing.
    expect(await spell('beach')).toBe('beach')
    expect(api.getTag).toHaveBeenCalledTimes(2)
    expect(librarySpellingResolver(api)).toBe(spell)
  })

  it('keeps a tag the library does not have, and asks again after a failure', async () => {
    const missing = Object.assign(new Error('Tag not found'), { status: 404 })
    const offline = new TypeError('offline')
    const api = { getTag: vi.fn().mockRejectedValueOnce(missing).mockRejectedValueOnce(offline).mockResolvedValue({ displayName: 'a (b)' }) }
    const spell = librarySpellingResolver(api)
    expect(await spell('x_y')).toBe('x_y')
    expect(await spell('x_y')).toBe('x_y')
    expect(await spell('a_b')).toBe('a_b')
    expect(await spell('a_b')).toBe('a_(b)')
    expect(api.getTag).toHaveBeenCalledTimes(3)
    expect(librarySpellingResolver({})).toBeNull()
  })
})
