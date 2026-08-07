// @vitest-environment jsdom
// The extension's booru import is a classic script sharing globals with the
// service worker, so load it through require() rather than an ESM import.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../browser-extension')
const booru = require(path.join(extensionDir, 'booru-tags.js'))

describe('detectBooruPost', () => {
  it('recognises the post pages of each supported family', () => {
    const cases = [
      ['https://danbooru.donmai.us/posts/9000000?q=touhou', 'danbooru'],
      ['https://safebooru.donmai.us/posts/12', 'danbooru'],
      ['https://gelbooru.com/index.php?page=post&s=view&id=11223344', 'gelbooru'],
      ['https://safebooru.org/index.php?page=post&s=view&id=4000000', 'gelbooru'],
      ['https://rule34.xxx/index.php?page=post&s=view&id=7', 'gelbooru'],
      ['https://yande.re/post/show/1000000', 'moebooru'],
      ['https://konachan.com/post/show/42', 'moebooru'],
      ['https://e621.net/posts/3000000', 'e621'],
    ]
    cases.forEach(([url, siteId]) => {
      expect(booru.detectBooruPost(url)?.siteId, url).toBe(siteId)
    })
  })

  it('reports Gelbooru as API-unusable so the DOM route is not skipped', () => {
    // Its dapi answers 401 without an api_key/user_id pair.
    expect(booru.detectBooruPost('https://gelbooru.com/index.php?page=post&s=view&id=1').apiUsable).toBe(false)
    expect(booru.detectBooruPost('https://safebooru.org/index.php?page=post&s=view&id=1').apiUsable).toBe(true)
  })

  it('ignores listings, non-post pages, and unrelated sites', () => {
    const misses = [
      'https://danbooru.donmai.us/posts?tags=touhou',
      'https://gelbooru.com/index.php?page=post&s=list&tags=all',
      'https://gelbooru.com/index.php?page=wiki&s=view&id=12',
      'https://x.com/someone/status/123',
      'https://example.com/posts/1',
      'not a url',
    ]
    misses.forEach((url) => expect(booru.detectBooruPost(url), url).toBeNull())
  })
})

describe('cleanBooruTagName', () => {
  it('strips the sidebar decoration a scrape picks up', () => {
    expect(booru.cleanBooruTagName('? hatsune_miku 1.2M')).toBe('hatsune_miku')
    expect(booru.cleanBooruTagName('  Kouzuki Kallen  ')).toBe('kouzuki_kallen')
    expect(booru.cleanBooruTagName('miyu_(blue_archive) 4729')).toBe('miyu_(blue_archive)')
    expect(booru.cleanBooruTagName('')).toBe('')
  })

  it('keeps a trailing number that is part of the tag', () => {
    // "2girls" and "fate/stay_night" must survive the post-count trim.
    expect(booru.cleanBooruTagName('2girls')).toBe('2girls')
  })
})

describe('parsers', () => {
  it('splits a Danbooru post into our categories', () => {
    const result = booru.parseDanbooruJson(
      {
        tag_string_general: '1girl solo smile',
        tag_string_character: 'c.c.',
        tag_string_copyright: 'code_geass',
        tag_string_artist: 'someartist',
        tag_string_meta: 'highres',
        rating: 'q',
        source: 'https://example.com/art',
      },
      { siteId: 'danbooru', label: 'Danbooru' },
    )
    expect(result.tags).toContain('c.c.')
    expect(result.categories['c.c.']).toBe('character')
    expect(result.categories.code_geass).toBe('copyright')
    expect(result.categories.someartist).toBe('artist')
    expect(result.categories.highres).toBe('meta')
    expect(result.categories['1girl']).toBe('general')
    expect(result.safety).toBe('sketchy')
    expect(result.source).toBe('https://example.com/art')
    expect(result.counts).toMatchObject({ general: 3, character: 1, copyright: 1, artist: 1, meta: 1 })
  })

  it('folds e621 species and lore into general and drops invalid', () => {
    const result = booru.parseE621Json(
      {
        post: {
          tags: {
            general: ['solo'],
            species: ['canine'],
            lore: ['backstory'],
            character: ['rex'],
            invalid: ['typo_tag'],
          },
          rating: 'e',
          sources: ['https://example.com/a'],
        },
      },
      { siteId: 'e621', label: 'e621' },
    )
    expect(result.categories).toEqual({
      solo: 'general',
      canine: 'general',
      backstory: 'general',
      rex: 'character',
    })
    expect(result.safety).toBe('unsafe')
  })

  it('reads a Gelbooru-style flat tag string, then applies tag types', () => {
    const result = booru.parseGelbooruJson([{ tags: 'hatsune_miku vocaloid 1girl', rating: 'safe' }], {
      siteId: 'gelbooru',
      label: 'Gelbooru-style',
    })
    expect(result.categories).toEqual({ hatsune_miku: 'general', vocaloid: 'general', '1girl': 'general' })

    booru.applyGelbooruTagTypes(result, [
      { name: 'hatsune_miku', type: 4 },
      { name: 'vocaloid', type: 3 },
      { name: '1girl', type: 0 },
    ])
    expect(result.categories).toEqual({ hatsune_miku: 'character', vocaloid: 'copyright', '1girl': 'general' })
    expect(result.counts).toMatchObject({ character: 1, copyright: 1, general: 1 })
  })

  it('parses the XML Safebooru answers with instead of JSON', () => {
    const rows = booru.parseGelbooruTagTypeXml(
      '<?xml version="1.0"?><tags><tag type="4" count="10" name="hatsune_miku"/><tag type="3" name="vocaloid"/></tags>',
    )
    expect(rows).toEqual([
      { name: 'hatsune_miku', type: 4 },
      { name: 'vocaloid', type: 3 },
    ])
  })

  it('returns null rather than an empty import when a post has no tags', () => {
    const context = { siteId: 'danbooru', label: 'Danbooru' }
    expect(booru.parseDanbooruJson({ tag_string_general: '' }, context)).toBeNull()
    expect(booru.parseGelbooruJson([], context)).toBeNull()
    expect(booru.resultFromScrape({ tags: [] }, context)).toBeNull()
    expect(booru.resultFromScrape(null, context)).toBeNull()
  })
})

describe('booruSafety', () => {
  it('maps every rating spelling the boards use', () => {
    expect(booru.booruSafety('g')).toBe('safe')
    expect(booru.booruSafety('general')).toBe('safe')
    expect(booru.booruSafety('safe')).toBe('safe')
    expect(booru.booruSafety('s')).toBe('sketchy')
    expect(booru.booruSafety('sensitive')).toBe('sketchy')
    expect(booru.booruSafety('Questionable')).toBe('sketchy')
    expect(booru.booruSafety('e')).toBe('unsafe')
    expect(booru.booruSafety('explicit')).toBe('unsafe')
    expect(booru.booruSafety('')).toBe('')
    expect(booru.booruSafety('nonsense')).toBe('')
  })
})

// Trimmed from real safebooru.org and gelbooru.com post pages. The leading "?"
// wiki link in every row is the trap: matching it yields an empty name and the
// whole import silently comes back with nothing.
const GELBOORU_SIDEBAR = `
<ul id="tag-sidebar">
  <li class="tag-type-copyright tag">
    <span class="sm-hidden"><a href="index.php?page=wiki&s=list&search=genshin_impact">?</a> </span>
    <a href="index.php?page=post&s=list&tags=genshin_impact">genshin impact</a>
    <span style="color: #a0a0a0;">168290</span>
  </li>
  <li class="tag-type-character tag">
    <span class="sm-hidden"><a href="index.php?page=wiki&s=list&search=yanfei_%28genshin_impact%29">?</a> </span>
    <a href="index.php?page=post&s=list&tags=yanfei_%28genshin_impact%29">yanfei (genshin impact)</a>
    <span style="color: #a0a0a0;">2751</span>
  </li>
  <li class="tag-type-artist tag">
    <span class="sm-hidden"><a href="index.php?page=wiki&s=list&search=nakaba_%28mode%29">?</a> </span>
    <a href="index.php?page=post&s=list&tags=nakaba_%28mode%29">nakaba (mode)</a>
  </li>
  <li class="tag-type-metadata tag">
    <span class="sm-hidden"><a href="index.php?page=wiki&s=list&search=highres">?</a> </span>
    <a href="index.php?page=post&s=list&tags=highres">highres</a>
  </li>
  <li class="tag-type-general tag">
    <span class="sm-hidden"><a href="index.php?page=wiki&s=list&search=1girl">?</a> </span>
    <a href="index.php?page=post&s=list&tags=1girl">1girl</a>
  </li>
</ul>
<div id="stats">Rating: Safe</div>`

// Danbooru numbers its categories and labels the anchor instead.
const DANBOORU_SIDEBAR = `
<ul>
  <li class="tag-type-4"><a class="search-tag" href="/posts?tags=c.c.">c.c.</a></li>
  <li class="tag-type-3"><a class="search-tag" href="/posts?tags=code_geass">code geass</a></li>
  <li class="tag-type-0"><a class="search-tag" href="/posts?tags=1girl">1girl</a></li>
</ul>`

describe('scrapeBooruTagsFromPage', () => {
  // @vitest-environment jsdom
  it('reads a Gelbooru-family sidebar without falling for the "?" wiki link', () => {
    document.body.innerHTML = GELBOORU_SIDEBAR
    const result = booru.resultFromScrape(booru.scrapeBooruTagsFromPage(), {
      siteId: 'gelbooru',
      label: 'Gelbooru-style',
    })
    expect(result.categories).toEqual({
      genshin_impact: 'copyright',
      'yanfei_(genshin_impact)': 'character',
      'nakaba_(mode)': 'artist',
      highres: 'meta',
      '1girl': 'general',
    })
    expect(result.safety).toBe('safe')
  })

  it('reads Danbooru numeric category classes', () => {
    document.body.innerHTML = DANBOORU_SIDEBAR
    const result = booru.resultFromScrape(booru.scrapeBooruTagsFromPage(), {
      siteId: 'danbooru',
      label: 'Danbooru',
    })
    expect(result.categories).toEqual({
      'c.c.': 'character',
      code_geass: 'copyright',
      '1girl': 'general',
    })
  })

  it('returns nothing on a page with no tag sidebar', () => {
    document.body.innerHTML = '<div><p>Just an article.</p></div>'
    expect(booru.scrapeBooruTagsFromPage().tags).toEqual([])
  })
})

describe('resultFromScrape', () => {
  it('keeps the strongest category when a tag appears twice', () => {
    const result = booru.resultFromScrape(
      {
        tags: [
          { name: 'c.c.', category: 'general' },
          { name: 'c.c.', category: 'character' },
          { name: 'code_geass', category: 'copyright' },
        ],
        rating: 'Questionable',
      },
      { siteId: 'gelbooru', label: 'Gelbooru-style' },
    )
    expect(result.categories['c.c.']).toBe('character')
    expect(result.safety).toBe('sketchy')
    expect(result.tags).toEqual(['c.c.', 'code_geass'])
  })
})
