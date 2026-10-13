import { describe, expect, it } from 'vitest'
import { decodeEntities } from './htmlEntities.js'
import { normalizeGelbooruPost } from './adapters/gelbooru.js'
import { normalizeSafebooruPost } from './adapters/safebooru.js'

describe('decodeEntities', () => {
  it('decodes the named, decimal and hex entities the dapi JSON uses', () => {
    expect(decodeEntities('a?x=1&amp;y=&#x32;&#039;&bogus;')).toBe("a?x=1&y=2'&bogus;")
    expect(decodeEntities('&gt;_&lt; &quot;hi&quot; &APOS;')).toBe('>_< "hi" \'')
    expect(decodeEntities('a&nbsp;b')).toBe('a b')
  })

  it('leaves out-of-range code points and non-strings alone', () => {
    expect(decodeEntities('&#0; &#x110000;')).toBe('&#0; &#x110000;')
    expect(decodeEntities(null)).toBe('')
    expect(decodeEntities(42)).toBe('42')
  })

  it('is the decoder both Gelbooru-family adapters use', () => {
    const source = 'https://e.com/?a=1&amp;b=2'
    const row = { id: 1, tags: 'cat', md5: 'a'.repeat(32), file_url: 'https://img.example/a.png', rating: 'general', source }
    expect(normalizeGelbooruPost(row).source).toBe('https://e.com/?a=1&b=2')
    expect(normalizeSafebooruPost({ ...row, directory: 'ab', image: 'a.png' }).source).toBe('https://e.com/?a=1&b=2')
  })
})
