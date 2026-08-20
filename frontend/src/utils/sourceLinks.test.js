import { describe, expect, it } from 'vitest'

import { pixivArtworkIdFromPost, pixivArtworkUrlFromPost } from './sourceLinks'

describe('Pixiv source links', () => {
  it('builds an artwork link from the shared Pixiv ID tag', () => {
    const post = { tags: ['multiple_images', 'pixiv_122812073', 'pixiv_122812073_p6'] }

    expect(pixivArtworkIdFromPost(post)).toBe('122812073')
    expect(pixivArtworkUrlFromPost(post)).toBe('https://www.pixiv.net/en/artworks/122812073')
  })

  it('does not mistake a page-specific tag for the artwork tag', () => {
    expect(pixivArtworkUrlFromPost({ tags: ['pixiv_122812073_p6'] })).toBe('')
  })

  it('supports detailed tag objects', () => {
    expect(pixivArtworkIdFromPost({ tags: [{ name: 'pixiv_44' }] })).toBe('44')
  })
})
