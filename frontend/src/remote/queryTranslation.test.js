import { describe, expect, it } from 'vitest'
import { DANBOORU_META, GELBOORU_META, SANKAKU_META, parseQuery, translateQuery } from './queryTranslation.js'

const SITES = ['danbooru', 'e621', 'sankaku', 'gelbooru', 'safebooru']
const ALL = { safe: true, sketchy: true, unsafe: true }

// Terms only, for the sites that have no budget to interfere.
function terms(site, q, options = {}) {
  return translateQuery(site, q, { safety: ALL, sort: 'date', order: 'desc', ...options }).terms
}

describe('parseQuery', () => {
  it('classifies tags, negations, ~terms and metatags', () => {
    expect(parseQuery('  cat_ears  -dog ~fox width:>=1000 Rating:e -safety:unsafe ')).toEqual([
      { kind: 'tag', value: 'cat_ears', raw: 'cat_ears' },
      { kind: 'neg', value: 'dog', raw: '-dog' },
      { kind: 'or', value: 'fox', raw: '~fox' },
      { kind: 'meta', key: 'width', op: '>=', value: '1000', negated: false, raw: 'width:>=1000' },
      { kind: 'meta', key: 'rating', op: '', value: 'e', negated: false, raw: 'Rating:e' },
      { kind: 'meta', key: 'safety', op: '', value: 'unsafe', negated: true, raw: '-safety:unsafe' },
    ])
    expect(parseQuery('')).toEqual([])
    expect(parseQuery(undefined)).toEqual([])
  })

  it('parses every comparison operator', () => {
    expect(parseQuery('height:<=5 height:<6 height:>7 height:8').map((t) => [t.op, t.value])).toEqual([
      ['<=', '5'], ['<', '6'], ['>', '7'], ['', '8'],
    ])
  })

  it('keeps colon tags that are no metatag as tags', () => {
    expect(parseQuery('re:zero_kara_hajimeru_isekai_seikatsu :d -re:zero').map((t) => t.kind)).toEqual(['tag', 'tag', 'neg'])
  })

  it('reads a bare 32 or 64 digit hex string as a hash, like the library', () => {
    const md5 = '1afe4a4b32b9460b7ec9fe9b77390513'
    expect(parseQuery(md5)[0]).toMatchObject({ kind: 'meta', key: 'hash', value: md5 })
    expect(parseQuery('1afe4a4b')[0]).toMatchObject({ kind: 'tag' })
  })

  it("reads the library's OR keyword as ~terms", () => {
    expect(parseQuery('cat OR dog solo').map((t) => [t.kind, t.value])).toEqual([['or', 'cat'], ['or', 'dog'], ['tag', 'solo']])
    expect(parseQuery('OR cat').map((t) => t.kind)).toEqual(['tag', 'tag'])
  })
})

describe('translateQuery: rating checkboxes', () => {
  const cases = [
    // [ticked, danbooru, e621, sankaku, gelbooru, safebooru]
    [ALL, [], [], [], [], []],
    [{ safe: true, sketchy: true, unsafe: false }, ['rating:g,s,q'], ['-rating:e'], ['-rating:e'], ['-rating:explicit'], ['-rating:explicit']],
    [{ safe: true, sketchy: false, unsafe: false }, ['rating:g'], ['-rating:q', '-rating:e'], ['-rating:q', '-rating:e'],
      ['-rating:sensitive', '-rating:questionable', '-rating:explicit'], ['-rating:questionable', '-rating:explicit']],
    [{ safe: false, sketchy: true, unsafe: true }, ['rating:s,q,e'], ['-rating:s'], ['-rating:s'], ['-rating:general'], ['-rating:general']],
    [{ safe: false, sketchy: false, unsafe: true }, ['rating:e'], ['-rating:s', '-rating:q'], ['-rating:s', '-rating:q'],
      ['-rating:general', '-rating:sensitive', '-rating:questionable'], ['-rating:general', '-rating:questionable']],
  ]

  it.each(cases)('%o', (safety, ...expected) => {
    SITES.forEach((site, index) => {
      expect(terms(site, '', { safety }), site).toEqual(expected[index])
    })
  })

  it('treats missing checkbox keys as ticked and always asks for the client filter', () => {
    for (const site of SITES) {
      const result = translateQuery(site, 'cat', {})
      expect(result).toEqual({ tags: 'cat', terms: ['cat'], ignored: [], clientSafetyFilter: true, note: null })
    }
  })
})

describe('translateQuery: sort', () => {
  const cases = [
    // [sort, order, danbooru, e621, gelbooru, safebooru, sankaku] as [terms, ignored]
    ['date', 'desc', [[], []], [[], []], [[], []], [[], []], [[], []]],
    ['id', 'desc', [[], []], [[], []], [[], []], [[], []], [[], []]],
    ['date', 'asc', [['order:id'], []], [['order:id'], []], [['sort:id:asc'], []], [['sort:id:asc'], []], [[], ['oldest-first']]],
    ['id', 'asc', [['order:id'], []], [['order:id'], []], [['sort:id:asc'], []], [['sort:id:asc'], []], [[], ['oldest-first']]],
    ['size', 'desc', [['order:filesize'], []], [['order:filesize'], []], [[], ['size sorting']], [[], ['size sorting']], [[], ['size sorting']]],
    ['size', 'asc', [['order:filesize_asc'], []], [['order:filesize_asc'], []], [[], ['size sorting']], [[], ['size sorting']], [[], ['size sorting']]],
  ]
  const order = ['danbooru', 'e621', 'gelbooru', 'safebooru', 'sankaku']

  it.each(cases)('%s %s', (sort, direction, ...expected) => {
    order.forEach((site, index) => {
      const result = translateQuery(site, '', { safety: ALL, sort, order: direction })
      expect([result.terms, result.ignored], site).toEqual(expected[index])
    })
  })

  it('defaults to newest first', () => {
    for (const site of SITES) expect(translateQuery(site, '', { safety: ALL }).terms).toEqual([])
  })
})

describe('translateQuery: terms', () => {
  it('passes plain tags, negations and wildcards everywhere, as typed', () => {
    for (const site of SITES) {
      expect(terms(site, 'Cat_Ears'), site).toEqual(['Cat_Ears'])
      expect(terms(site, '-dog'), site).toEqual(['-dog'])
      expect(terms(site, 'miyu_*'), site).toEqual(['miyu_*'])
      expect(terms(site, '*_(blue_archive)'), site).toEqual(['*_(blue_archive)'])
    }
  })

  it('passes ~tag only to Danbooru and e621', () => {
    expect(terms('danbooru', '~cat ~dog')).toEqual(['~cat', '~dog'])
    expect(terms('e621', '~cat ~dog')).toEqual(['~cat', '~dog'])
    for (const site of ['sankaku', 'gelbooru', 'safebooru']) {
      const result = translateQuery(site, 'solo ~cat', { safety: ALL })
      expect(result.terms, site).toEqual(['solo'])
      expect(result.ignored, site).toEqual(['~cat'])
    }
  })

  it("sends the library's OR group as ~terms", () => {
    expect(terms('e621', 'cat OR dog')).toEqual(['~cat', '~dog'])
    expect(translateQuery('gelbooru', 'cat OR dog solo', { safety: ALL }).ignored).toEqual(['cat', 'dog'])
  })

  it('folds safety: and rating: into the rating term', () => {
    // NekoBooru values.
    expect(terms('danbooru', 'safety:safe')).toEqual(['rating:g'])
    expect(terms('danbooru', '-safety:unsafe')).toEqual(['rating:g,s,q'])
    expect(terms('e621', 'safety:sketchy')).toEqual(['-rating:s', '-rating:e'])
    expect(terms('sankaku', '-safety:unsafe')).toEqual(['-rating:e'])
    expect(terms('gelbooru', 'safety:unsafe')).toEqual(['-rating:general', '-rating:sensitive', '-rating:questionable'])
    expect(terms('safebooru', '-rating:sketchy')).toEqual(['-rating:questionable'])
    // The site's own letters and words.
    expect(terms('danbooru', 'rating:s')).toEqual(['rating:s,q'])
    expect(terms('danbooru', 'rating:g,s')).toEqual(['rating:g,s,q'])
    expect(terms('e621', 'rating:s')).toEqual(['-rating:q', '-rating:e'])
    expect(terms('sankaku', '-rating:e')).toEqual(['-rating:e'])
    expect(terms('gelbooru', 'rating:explicit')).toEqual(['-rating:general', '-rating:sensitive', '-rating:questionable'])
    expect(terms('gelbooru', '-rating:general')).toEqual(['-rating:general'])
    expect(terms('safebooru', 'rating:general')).toEqual(['-rating:questionable', '-rating:explicit'])
  })

  it('narrows the ticked set rather than widening it', () => {
    const safety = { safe: true, sketchy: false, unsafe: true }
    expect(terms('danbooru', 'safety:sketchy', { safety })).toEqual([])
    expect(terms('e621', 'safety:sketchy', { safety })).toEqual(['-rating:s', '-rating:q', '-rating:e'])
    expect(terms('danbooru', '-safety:safe', { safety })).toEqual(['rating:e'])
  })

  it('ignores ratings a site cannot read', () => {
    for (const site of SITES) {
      const result = translateQuery(site, 'rating:bogus safety:>safe', { safety: ALL })
      expect(result.terms, site).toEqual([])
      expect(result.ignored, site).toEqual(['rating:bogus', 'safety:>safe'])
    }
  })

  it('maps md5:, hash: and bare md5 strings to md5:', () => {
    const md5 = '1AFE4A4B32B9460B7EC9FE9B77390513'
    for (const site of SITES) {
      expect(terms(site, `md5:${md5}`), site).toEqual([`md5:${md5.toLowerCase()}`])
      expect(terms(site, `hash:${md5}`), site).toEqual([`md5:${md5.toLowerCase()}`])
      expect(terms(site, md5), site).toEqual([`md5:${md5.toLowerCase()}`])
    }
    const sha256 = 'a'.repeat(64)
    const result = translateQuery('e621', `hash:${sha256} md5:abc`, { safety: ALL })
    expect(result.terms).toEqual([])
    expect(result.ignored).toEqual([`hash:${sha256}`, 'md5:abc'])
  })

  it('passes width: and height: with their operator', () => {
    for (const site of SITES) {
      expect(terms(site, 'width:>=1000 HEIGHT:<500'), site).toEqual(['width:>=1000', 'height:<500'])
      expect(terms(site, 'width:1920'), site).toEqual(['width:1920'])
    }
  })

  it('ignores filters only the library understands', () => {
    const q = 'sha256:abc fav:me favorite:me pool:3 type:video sort:random'
    for (const site of SITES) {
      const result = translateQuery(site, q, { safety: ALL })
      expect(result.terms, site).toEqual([])
      expect(result.ignored, site).toEqual(q.split(' '))
    }
  })

  it("passes other metatags only where the site knows the key", () => {
    expect(terms('e621', 'score:>10 favcount:>5 -user:bob')).toEqual(['score:>10', 'favcount:>5', '-user:bob'])
    expect(terms('sankaku', 'threshold:3 file_type:video')).toEqual(['threshold:3', 'file_type:video'])
    expect(terms('gelbooru', 'score:>10 status:active')).toEqual(['score:>10', 'status:active'])
    expect(terms('safebooru', 'parent:1')).toEqual(['parent:1'])
    expect(terms('danbooru', 'mpixels:>2')).toEqual(['mpixels:>2'])

    const sankaku = translateQuery('sankaku', 'cat favcount:>5 order:score', { safety: ALL })
    expect(sankaku).toMatchObject({ terms: ['cat'], ignored: ['favcount:>5', 'order:score'], note: null })
    const gelbooru = translateQuery('gelbooru', 'threshold:3 mpixels:>2', { safety: ALL })
    expect(gelbooru).toMatchObject({ terms: [], ignored: ['threshold:3', 'mpixels:>2'] })
  })

  it('keeps the meta key lists from the plan', () => {
    expect(DANBOORU_META).toContain('favcount')
    expect(SANKAKU_META).toContain('threshold')
    expect(GELBOORU_META).toContain('sort')
  })

  it('rejects unknown sites', () => {
    expect(() => translateQuery('pixiv', 'cat')).toThrow(/Unknown booru site/)
  })
})

describe('translateQuery: Danbooru two-term budget', () => {
  const noUnsafe = { safe: true, sketchy: true, unsafe: false }
  const run = (q, options = {}) => translateQuery('danbooru', q, { safety: ALL, sort: 'date', order: 'desc', ...options })

  it('sends everything when it fits', () => {
    expect(run('')).toEqual({ tags: '', terms: [], ignored: [], clientSafetyFilter: true, note: null })
    expect(run('cat')).toMatchObject({ terms: ['cat'], note: null })
    expect(run('cat dog')).toMatchObject({ tags: 'cat dog', terms: ['cat', 'dog'], ignored: [], note: null })
    expect(run('', { safety: noUnsafe, order: 'asc' })).toMatchObject({ terms: ['rating:g,s,q', 'order:id'], note: null })
    expect(run('cat', { safety: noUnsafe })).toMatchObject({ terms: ['cat', 'rating:g,s,q'], note: null })
    expect(run('cat', { order: 'asc' })).toMatchObject({ terms: ['cat', 'order:id'], note: null })
  })

  it('cuts the rest in priority order and says so', () => {
    expect(run('cat dog fox')).toMatchObject({
      tags: 'cat dog',
      terms: ['cat', 'dog'],
      ignored: ['fox'],
      note: 'Danbooru allows 2 search terms without an account; ignored: fox',
    })
    expect(run('cat', { safety: noUnsafe, order: 'asc' })).toMatchObject({
      terms: ['cat', 'rating:g,s,q'],
      ignored: ['order:id'],
      note: 'Danbooru allows 2 search terms without an account; ignored: order:id',
    })
    expect(run('cat dog', { safety: noUnsafe, sort: 'size' })).toMatchObject({
      terms: ['cat', 'dog'],
      ignored: ['rating:g,s,q', 'order:filesize'],
    })
    expect(run('cat dog fox', { safety: noUnsafe, order: 'asc' })).toMatchObject({
      terms: ['cat', 'dog'],
      ignored: ['fox', 'rating:g,s,q', 'order:id'],
    })
    expect(run('', { safety: noUnsafe, order: 'asc' }).note).toBeNull()
  })

  it('ranks plain tags, then negations, ~terms, rating, order, other metatags', () => {
    expect(run('width:>100 ~fox -dog cat').terms).toEqual(['cat', '-dog'])
    expect(run('width:>100 ~fox -dog').terms).toEqual(['-dog', '~fox'])
    expect(run('width:>100 ~fox', { safety: noUnsafe }).terms).toEqual(['~fox', 'rating:g,s,q'])
    expect(run('width:>100 score:>5', { order: 'asc' })).toMatchObject({ terms: ['order:id', 'width:>100'], ignored: ['score:>5'] })
  })

  it('lists unsupported terms before the cut ones', () => {
    expect(run('cat dog fox pool:3')).toMatchObject({ ignored: ['pool:3', 'fox'] })
  })

  it('applies to Danbooru only', () => {
    expect(translateQuery('e621', 'cat dog fox', { safety: noUnsafe, order: 'asc' })).toMatchObject({
      terms: ['cat', 'dog', 'fox', '-rating:e', 'order:id'],
      note: null,
    })
  })
})
