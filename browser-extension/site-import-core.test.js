const assert = require('node:assert/strict')
const core = require('./site-import-core.js')

assert.equal(core.pixivArtworkId('https://www.pixiv.net/en/artworks/122812376'), '122812376')
assert.equal(core.gelbooruPostId('https://gelbooru.com/index.php?page=post&s=view&id=44'), '44')
assert.equal(core.safebooruPostId('https://safebooru.org/index.php?page=post&s=view&id=55'), '55')
assert.equal(core.safebooruPostId('https://gelbooru.com/index.php?page=post&s=view&id=55'), '')

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

const ugoiraJob = core.pixivImportJob(
  {
    body: {
      illustTitle: 'Animated work',
      illustType: 2,
      userId: '55',
      userName: 'Artist Name',
      tags: { tags: [{ tag: 'うごイラ' }] },
    },
  },
  { body: [{ urls: { original: 'https://i.pximg.net/preview.jpg' }, width: 1920, height: 1080 }] },
  'https://www.pixiv.net/en/artworks/92781927',
  {
    body: {
      originalSrc: 'https://i.pximg.net/img-zip-ugoira/original.zip',
      frames: [{ file: '000000.jpg', delay: 60 }, { file: '000001.jpg', delay: 120 }],
    },
  },
)
assert.equal(ugoiraJob.isUgoira, true)
assert.equal(ugoiraJob.media.length, 1)
assert.equal(ugoiraJob.media[0].type, 'ugoira')
assert.equal(ugoiraJob.media[0].url, 'https://i.pximg.net/img-zip-ugoira/original.zip')
assert.equal(ugoiraJob.media[0].frameCount, 2)
assert.deepEqual(ugoiraJob.media[0].frames, [
  { file: '000000.jpg', delay: 60 },
  { file: '000001.jpg', delay: 120 },
])
assert.ok(ugoiraJob.media[0].tags.includes('ugoira'))
assert.equal(ugoiraJob.media[0].source, 'https://www.pixiv.net/en/artworks/92781927')

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

const safebooruJob = core.safebooruImportJob(
  [{
    id: 55,
    file_url: 'https://safebooru.org/images/1/original.jpg?55',
    tags: 'solo hatsune_miku highres',
    rating: 'general',
    width: 1600,
    height: 1200,
  }],
  {
    rating: 'General',
    tags: [
      { name: 'Hatsune Miku', category: 'character' },
      { name: 'highres', category: 'meta' },
    ],
  },
  'https://safebooru.org/index.php?page=post&s=view&id=55',
)
assert.equal(safebooruJob.kind, 'safebooru')
assert.equal(safebooruJob.media[0].url, 'https://safebooru.org/images/1/original.jpg?55')
assert.equal(safebooruJob.media[0].tagCategories.hatsune_miku, 'character')
assert.equal(safebooruJob.media[0].tagCategories.highres, 'meta')
assert.equal(safebooruJob.media[0].tagCategories.safebooru_55, 'meta')
assert.equal(safebooruJob.media[0].safety, 'safe')

const sanitizedSafebooru = core.sanitizeSafebooruImportJob(
  safebooruJob,
  'https://safebooru.org/index.php?page=post&s=view&id=55',
)
assert.equal(sanitizedSafebooru.canonicalUrl, 'https://safebooru.org/index.php?page=post&s=view&id=55')
assert.equal(sanitizedSafebooru.media[0].referer, 'https://safebooru.org/')
assert.equal(sanitizedSafebooru.media[0].tagCategories.hatsune_miku, 'character')
assert.throws(
  () => core.sanitizeSafebooruImportJob(safebooruJob, 'https://safebooru.org/index.php?page=post&s=view&id=56'),
  /post ID mismatch/,
)
assert.throws(
  () => core.sanitizeSafebooruImportJob(
    { ...safebooruJob, media: [{ ...safebooruJob.media[0], url: 'https://safebooru.org/samples/sample.jpg' }] },
    'https://safebooru.org/index.php?page=post&s=view&id=55',
  ),
  /trusted original URL/,
)

const sidebarFavorite = { parentElement: { textContent: 'Add to favorites' } }
const actionFavorite = { parentElement: { textContent: 'Edit | Leave a Comment | Unfavorite' } }
assert.equal(
  core.selectGelbooruActionFavorite([sidebarFavorite, actionFavorite]),
  actionFavorite,
)

const unrelatedPixivControl = {
  dataset: {},
  getAttribute: () => '',
  getBoundingClientRect: () => ({ width: 32, height: 32, bottom: 100, right: 100 }),
  querySelector: () => null,
  textContent: 'Like',
  title: '',
}
const pixivShare = {
  ...unrelatedPixivControl,
  getAttribute: (name) => name === 'aria-label' ? 'Share' : '',
  textContent: '',
}
assert.equal(core.selectPixivShareControl([unrelatedPixivControl, pixivShare]), pixivShare)

const pixivRowControl = (textContent, left, width = 32) => ({
  contains: () => false,
  dataset: {},
  getAttribute: () => '',
  getBoundingClientRect: () => ({ left, right: left + width, top: 10, bottom: 42, width, height: 32 }),
  querySelector: () => null,
  textContent,
  title: '',
})
const pixivLike = pixivRowControl('Like', 10, 50)
const pixivHeart = pixivRowControl('', 68)
const unlabeledPixivShare = pixivRowControl('', 108)
const pixivMore = pixivRowControl('', 148)
assert.equal(
  core.selectPixivShareControl([pixivLike, pixivHeart, unlabeledPixivShare, pixivMore]),
  unlabeledPixivShare,
)

const pixivToolbarWrapper = {
  ...pixivRowControl('Share', 0, 190),
  contains: (node) => [pixivLike, pixivHeart, unlabeledPixivShare, pixivMore].includes(node),
}
pixivMore.getAttribute = (name) => name === 'aria-label' ? 'More' : ''
assert.equal(
  core.selectPixivShareControl([
    pixivToolbarWrapper,
    pixivLike,
    pixivHeart,
    unlabeledPixivShare,
    pixivMore,
  ]),
  unlabeledPixivShare,
)
const iconOnlyLike = pixivRowControl('', 10, 50)
assert.equal(
  core.selectPixivShareControl([iconOnlyLike, pixivHeart, unlabeledPixivShare, pixivMore]),
  unlabeledPixivShare,
)
const pixivBookmark = pixivRowControl('', 68)
pixivBookmark.getAttribute = (name) => name === 'aria-label' ? 'Add to bookmarks' : ''
const unlabeledMore = pixivRowControl('', 148)
assert.equal(
  core.selectPixivShareControl([pixivBookmark, unlabeledPixivShare, unlabeledMore]),
  unlabeledPixivShare,
)
assert.deepEqual(
  core.selectedSiteImportMedia(job.media, [1]),
  [job.media[1]],
)
assert.ok(core.selectedSiteImportMedia(job.media, [1])[0].tags.includes('pixiv_122812376_p2'))

console.log('site-import-core tests passed')
