const assert = require('node:assert/strict')
const core = require('./site-import-core.js')

assert.equal(core.pixivArtworkId('https://www.pixiv.net/en/artworks/122812376'), '122812376')
assert.equal(core.gelbooruPostId('https://gelbooru.com/index.php?page=post&s=view&id=44'), '44')

const job = core.pixivImportJob(
  {
    body: {
      illustTitle: 'Two pages',
      userId: '55',
      userName: 'Artist Name',
      xRestrict: 1,
      tags: { tags: [{ tag: 'ブルーアーカイブ', translation: { en: 'Blue Archive' } }] },
    },
  },
  {
    body: [
      { urls: { regular: 'https://i.pximg.net/regular-p0.jpg', original: 'https://i.pximg.net/original-p0.png' }, width: 2000, height: 3000 },
      { urls: { regular: 'https://i.pximg.net/regular-p1.jpg', original: 'https://i.pximg.net/original-p1.jpg' }, width: 2400, height: 1800 },
    ],
  },
  'https://www.pixiv.net/en/artworks/122812376',
)

assert.deepEqual(job.media.map((item) => item.url), [
  'https://i.pximg.net/original-p0.png',
  'https://i.pximg.net/original-p1.jpg',
])
assert.equal(job.media[0].safety, 'unsafe')
assert.ok(job.media[0].tags.includes('blue_archive'))
assert.ok(job.media[0].tags.includes('pixiv_122812376'))
assert.ok(job.media[0].tags.includes('pixiv_122812376_p1'))
assert.ok(job.media[1].tags.includes('pixiv_122812376_p2'))
assert.ok(job.media[0].tags.includes('artist_name'))
assert.equal(job.media[0].tagCategories.artist_name, 'artist')
assert.equal(job.media[0].tagCategories.pixiv_user_55, 'artist')
assert.equal(job.media[0].tagDisplayNames.artist_name, 'Artist Name')
assert.equal(job.media[0].source, 'https://www.pixiv.net/en/artworks/122812376')

const pixivPostBody = core.siteImportPostBody(job, job.media[0], 'pixiv-token')
assert.equal(pixivPostBody.autoTag, true)
assert.equal(pixivPostBody.autoTagProfile, 'pixiv_import')
assert.equal(pixivPostBody.contentToken, 'pixiv-token')

const gelbooruPostBody = core.siteImportPostBody(
  { kind: 'gelbooru', canonicalUrl: 'https://gelbooru.com/index.php?page=post&s=view&id=44' },
  { tags: ['solo'], safety: 'safe' },
  'gelbooru-token',
)
assert.equal(gelbooruPostBody.autoTag, false)
assert.equal(gelbooruPostBody.autoTagProfile, 'gelbooru_import')

const sidebarFavorite = { parentElement: { textContent: 'Add to favorites' } }
const actionFavorite = { parentElement: { textContent: 'Edit | Leave a Comment | Unfavorite' } }
assert.equal(
  core.selectGelbooruActionFavorite([sidebarFavorite, actionFavorite]),
  actionFavorite,
)

console.log('site-import-core tests passed')
