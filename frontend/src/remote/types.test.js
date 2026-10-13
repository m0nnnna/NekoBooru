// The extension's site import core is a classic script, so it is loaded
// through require() (as in utils/booruTags.test.js) for the parity check.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeTagName } from '../utils/booruSearchTag.js'
import {
  CATEGORIES,
  LIBRARY_SOURCE,
  RemoteSearchError,
  SAFETY_ORDER,
  SITES,
  SOURCE_IDS,
  booruDisplayNames,
  effectiveLimit,
  idTagFor,
  isRemoteKey,
  libraryIdFromKey,
  libraryKey,
  makeKey,
  mediaTypeFromExt,
  siteById,
  splitKey,
  stricterSafety,
} from './types.js'

const require = createRequire(import.meta.url)
const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../browser-extension')
const core = require(path.join(extensionDir, 'site-import-core.js'))

describe('site registry', () => {
  it('lists the library first and every booru in display order', () => {
    expect(LIBRARY_SOURCE).toBe('nekobooru')
    expect(SOURCE_IDS).toEqual(['nekobooru', 'danbooru', 'e621', 'sankaku', 'gelbooru', 'safebooru'])
    expect(SITES.filter((site) => site.transport === 'relay').map((site) => site.id)).toEqual(['gelbooru', 'safebooru'])
    expect(siteById('e621')).toMatchObject({ label: 'e621 / e926', referer: 'https://e621.net/' })
    expect(siteById('nope')).toBeNull()
    expect(SAFETY_ORDER).toEqual(['safe', 'sketchy', 'unsafe'])
    expect([...CATEGORIES]).toEqual(['general', 'artist', 'copyright', 'character', 'meta'])
  })
})

describe('page sizes', () => {
  it("records each booru's own default and maximum", () => {
    expect(Object.fromEntries(SITES.map((site) => [site.id, [site.defaultLimit, site.maxLimit]]))).toEqual({
      danbooru: [20, 200],
      e621: [75, 320],
      sankaku: [20, 100],
      gelbooru: [42, 100],
      safebooru: [42, 100],
    })
  })

  it('uses the default unless the user picked a number', () => {
    for (const site of SITES) {
      for (const requested of [null, undefined, 'default', '', 'abc', 0, -5, NaN]) {
        expect(effectiveLimit(site.id, requested), `${site.id} ${requested}`).toBe(site.defaultLimit)
      }
    }
  })

  it('caps a picked number at the maximum', () => {
    expect(effectiveLimit('danbooru', 50)).toBe(50)
    expect(effectiveLimit('danbooru', '100')).toBe(100)
    expect(effectiveLimit('danbooru', 500)).toBe(200)
    expect(effectiveLimit('e621', 500)).toBe(320)
    expect(effectiveLimit('sankaku', 200)).toBe(100)
    expect(effectiveLimit('gelbooru', 100)).toBe(100)
    expect(effectiveLimit('safebooru', 101)).toBe(100)
    expect(effectiveLimit('e621', 12.7)).toBe(12)
    expect(() => effectiveLimit('pixiv', 10)).toThrow(/Unknown booru site/)
  })
})

describe('selection keys', () => {
  it('round-trips numeric and alphanumeric ids', () => {
    expect(makeKey('danbooru', '123')).toBe('danbooru:123')
    expect(splitKey('danbooru:123')).toEqual({ site: 'danbooru', id: '123' })
    expect(splitKey(makeKey('sankaku', 'zjrmd0QxWaD'))).toEqual({ site: 'sankaku', id: 'zjrmd0QxWaD' })
    expect(splitKey('nekobooru:42')).toEqual({ site: 'nekobooru', id: '42' })
  })

  it('rejects malformed keys', () => {
    for (const bad of [null, undefined, 42, '', 'danbooru', 'danbooru:', ':123', 'pixiv:1', 'danbooru:1 2', 'danbooru:1:2']) {
      expect(splitKey(bad)).toBeNull()
    }
  })

  it('tells remote keys from library keys', () => {
    expect(isRemoteKey('danbooru:1')).toBe(true)
    expect(isRemoteKey('sankaku:zjrmd0QxWaD')).toBe(true)
    expect(isRemoteKey('nekobooru:42')).toBe(false)
    expect(isRemoteKey('garbage')).toBe(false)
    expect(isRemoteKey(42)).toBe(false)
  })

  it('builds and reads library keys', () => {
    expect(libraryKey(42)).toBe('nekobooru:42')
    expect(libraryIdFromKey('nekobooru:42')).toBe(42)
    expect(libraryIdFromKey(libraryKey(7))).toBe(7)
    expect(libraryIdFromKey('danbooru:42')).toBeNull()
    expect(libraryIdFromKey('nekobooru:abc')).toBeNull()
    expect(libraryIdFromKey('nekobooru:0')).toBeNull()
    expect(libraryIdFromKey(42)).toBeNull()
  })

  it('names the id tag an import carries', () => {
    expect(idTagFor({ site: 'danbooru', id: '123' })).toBe('danbooru_123')
    expect(idTagFor({ site: 'e621', id: '6776680' })).toBe('e621_6776680')
    // Stored lower-cased, as the extension's normalizeTag(`sankaku_${id}`) does.
    expect(idTagFor({ site: 'sankaku', id: 'zjrmd0QxWaD' })).toBe('sankaku_zjrmd0qxwad')
    expect(idTagFor({ site: 'sankaku', id: 'zjrmd0QxWaD' })).toBe(core.normalizeTag('sankaku_zjrmd0QxWaD'))
  })
})

describe('stricterSafety', () => {
  it('keeps the stricter rating, unknown counting as safe', () => {
    expect(stricterSafety('safe', 'unsafe')).toBe('unsafe')
    expect(stricterSafety('sketchy', 'safe')).toBe('sketchy')
    expect(stricterSafety('unsafe', 'sketchy')).toBe('unsafe')
    expect(stricterSafety('safe', 'safe')).toBe('safe')
    expect(stricterSafety(undefined, 'bogus')).toBe('safe')
    expect(stricterSafety('', 'sketchy')).toBe('sketchy')
  })
})

describe('booruDisplayNames', () => {
  const raw = ['miyu_(blue_archive)', 'cat_ears', '1girl', '?', '@_@', ':d', 'seitokai_ni_mo_ana_wa_aru!', 'k-on!', 're:zero_kara_hajimeru_isekai_seikatsu']

  it('keys the booru spelling by the flattened tag name', () => {
    expect(booruDisplayNames(raw)).toEqual({
      miyu_blue_archive: 'miyu (blue archive)',
      seitokai_ni_mo_ana_wa_aru: 'seitokai ni mo ana wa aru!',
      'k-on': 'k-on!',
    })
    expect(booruDisplayNames([])).toEqual({})
    expect(booruDisplayNames(undefined)).toEqual({})
  })

  it('picks the same tags as the extension', () => {
    const [media] = core.gelbooruSearchMedia({ posts: [{ postId: 1, tags: raw }] })
    const extension = Object.fromEntries(
      Object.entries(media.tagDisplayNames).map(([tag, name]) => [normalizeTagName(tag), name]),
    )
    expect(booruDisplayNames(raw)).toEqual(extension)
  })
})

describe('mediaTypeFromExt', () => {
  it('follows the RemotePost mediaType rule', () => {
    expect(mediaTypeFromExt('gif')).toBe('gif')
    for (const ext of ['mp4', 'webm', 'mov', 'm4v', 'zip']) expect(mediaTypeFromExt(ext)).toBe('video')
    for (const ext of ['jpg', 'JPEG', '.png', 'webp', 'avif']) expect(mediaTypeFromExt(ext)).toBe('image')
    expect(mediaTypeFromExt('swf')).toBe('unknown')
    expect(mediaTypeFromExt('')).toBe('unknown')
    expect(mediaTypeFromExt(null)).toBe('unknown')
  })
})

describe('RemoteSearchError', () => {
  it('carries the fields the section header branches on', () => {
    const error = new RemoteSearchError({ site: 'danbooru', status: 429, message: 'slow down', retryAfterMs: 60_000, kind: 'throttled' })
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'RemoteSearchError', site: 'danbooru', status: 429, message: 'slow down', retryAfterMs: 60_000, kind: 'throttled' })
    const fallback = new RemoteSearchError({ site: 'e621', kind: 'weird' })
    expect(fallback).toMatchObject({ kind: 'upstream', status: null, retryAfterMs: null, message: 'e621 / e926 request failed' })
  })
})
