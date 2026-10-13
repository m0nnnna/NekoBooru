const assert = require('node:assert/strict')
const core = require('./site-import-core.js')

assert.equal(core.pixivArtworkId('https://www.pixiv.net/en/artworks/122812376'), '122812376')
assert.equal(core.gelbooruPostId('https://gelbooru.com/index.php?page=post&s=view&id=44'), '44')
assert.equal(core.gelbooruPostId('https://ja.gelbooru.com/index.php?page=post&s=view&id=44'), '44')
assert.equal(core.isGelbooruHost('ja.gelbooru.com'), true)
assert.equal(core.isGelbooruHost('gelbooru.com.evil.example'), false)
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

// Sankaku: both front-ends, case-sensitive alphanumeric IDs.
assert.equal(core.sankakuPostId('https://chan.sankakucomplex.com/posts/y0abNDZNoa2'), 'y0abNDZNoa2')
assert.equal(core.sankakuPostId('https://sankaku.app/posts/26MPwBzomRK?tags=rating%3As&tab=explore'), '26MPwBzomRK')
assert.equal(core.sankakuPostId('https://sankaku.app/en/posts/26MPwBzomRK'), '26MPwBzomRK')
assert.equal(core.sankakuPostId('https://chan.sankakucomplex.com/post/show/123456'), '')
assert.equal(core.sankakuPostId('https://sankaku.app/?tags=blue_hair'), '')
assert.equal(core.sankakuPostId('https://idol.sankakucomplex.com/posts/y0abNDZNoa2'), '')
assert.equal(core.sankakuPostId('https://sankaku.app.evil.example/posts/y0abNDZNoa2'), '')
assert.equal(core.isSankakuHost('www.sankakucomplex.com'), true)
// SauceNAO's old numeric links 404; posts/similar still resolves them.
assert.equal(
  core.sankakuLegacyPostUrl('https://chan.sankakucomplex.com/post/show/4491595'),
  'https://chan.sankakucomplex.com/posts/similar?id=4491595',
)
assert.equal(
  core.sankakuLegacyPostUrl('http://chan.sankakucomplex.com/en/post/show/4491595/'),
  'https://chan.sankakucomplex.com/posts/similar?id=4491595',
)
assert.equal(core.sankakuLegacyPostUrl('https://chan.sankakucomplex.com/posts/y0abNDZNoa2'), '')
assert.equal(core.sankakuLegacyPostUrl('https://idol.sankakucomplex.com/post/show/4491595'), '')
assert.equal(core.sankakuLegacyPostUrl('https://evil.example/post/show/4491595'), '')
assert.equal(core.sankakuSafety('s'), 'safe')
assert.equal(core.sankakuSafety('q'), 'sketchy')
assert.equal(core.sankakuSafety('e'), 'unsafe')
const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl'
assert.equal(core.sankakuAccessToken(jwtLike), jwtLike)
assert.equal(core.sankakuAccessToken(JSON.stringify(jwtLike)), jwtLike)
assert.equal(core.sankakuAccessToken('not a token; evil=1'), '')

const sankakuPayload = {
  id: 'y0abNDZNoa2',
  rating: 's',
  file_url: 'https://s.sankakucomplex.com/o/62/4e/624e.jpg?e=1791161510&m=abc',
  file_type: 'image/jpeg',
  width: 373,
  height: 900,
  tags: [
    { tagName: 'etotama', type: 3 },
    { tagName: 'encourage_films', type: 2 },
    { tagName: 'kii-tan', type: 4 },
    { tagName: 'clothing', type: 0 },
    { tagName: 'official_art', type: 9 },
    { tagName: 'png-to-jpg_conversion', type: 8 },
    { tagName: 'honoka_(dead_or_alive)', type: 4 },
  ],
}
const sankakuJob = core.sankakuImportJob(sankakuPayload, 'https://chan.sankakucomplex.com/posts/y0abNDZNoa2')
assert.equal(sankakuJob.kind, 'sankaku')
assert.equal(sankakuJob.canonicalUrl, 'https://chan.sankakucomplex.com/posts/y0abNDZNoa2')
assert.equal(sankakuJob.groupTag, 'sankaku_y0abndznoa2')
assert.equal(sankakuJob.media[0].url, sankakuPayload.file_url)
assert.equal(sankakuJob.media[0].safety, 'safe')
assert.deepEqual(sankakuJob.media[0].tagCategories, {
  etotama: 'copyright',
  encourage_films: 'artist',
  'kii-tan': 'character',
  clothing: 'general',
  official_art: 'meta',
  'png-to-jpg_conversion': 'meta',
  'honoka_(dead_or_alive)': 'character',
  sankaku_y0abndznoa2: 'meta',
})
assert.throws(
  () => core.sankakuImportJob({ ...sankakuPayload, file_url: '' }, 'https://sankaku.app/posts/y0abNDZNoa2'),
  /Log in to Sankaku/,
)
// Questionable/explicit posts: the API withholds file_url, the page shows it.
const pageOriginal = 'https://s.sankakucomplex.com/data/ab/cd/abcd.jpg?e=1&m=x'
assert.equal(
  core.sankakuImportJob({ ...sankakuPayload, file_url: null }, 'https://chan.sankakucomplex.com/en/posts/y0abNDZNoa2', pageOriginal).media[0].url,
  pageOriginal,
)
assert.equal(core.sankakuOriginalFromPage('https://evil.example/abcd.jpg'), '')
// A page link back to the front-end is not an original file.
assert.equal(core.sankakuOriginalFromPage('https://chan.sankakucomplex.com/posts/e8M5Yy3XpMz'), '')
assert.equal(core.sankakuOriginalFromPage('https://v.sankakucomplex.com/data/ab/cd/abcd.mp4?e=1'), 'https://v.sankakucomplex.com/data/ab/cd/abcd.mp4?e=1')
assert.equal(sankakuJob.media[0].referer, 'https://sankaku.app/')
assert.equal(core.sankakuOriginalFromPage('http://s.sankakucomplex.com/data/abcd.jpg'), '')
assert.throws(
  () => core.sankakuImportJob({ ...sankakuPayload, file_url: null }, 'https://sankaku.app/posts/y0abNDZNoa2', 'https://evil.example/x.jpg'),
  /Log in to Sankaku/,
)
assert.throws(
  () => core.sankakuImportJob(sankakuPayload, 'https://sankaku.app/posts/otherPost1'),
  /did not return this post/,
)

const appJob = core.sankakuImportJob({ ...sankakuPayload, file_type: 'video/mp4' }, 'https://sankaku.app/posts/y0abNDZNoa2')
const sanitizedSankaku = core.sanitizeSankakuImportJob(appJob, 'https://sankaku.app/posts/y0abNDZNoa2?tab=explore')
assert.equal(sanitizedSankaku.canonicalUrl, 'https://sankaku.app/posts/y0abNDZNoa2')
assert.equal(sanitizedSankaku.media[0].type, 'video')
assert.equal(sanitizedSankaku.media[0].tagCategories.etotama, 'copyright')
assert.throws(
  () => core.sanitizeSankakuImportJob(appJob, 'https://sankaku.app/posts/otherPost1'),
  /post ID mismatch/,
)
assert.throws(
  () => core.sanitizeSankakuImportJob({ ...appJob, media: [{ ...appJob.media[0], url: 'https://evil.example/x.jpg' }] }, 'https://sankaku.app/posts/y0abNDZNoa2'),
  /trusted original/,
)

// Login-only posts: rebuilt from the page's Original link, sidebar and rating.
const pageJob = core.sankakuPageImportJob({
  originalUrl: 'https://s.sankakucomplex.com/o/aa/bb/aabb.png?e=1&m=x',
  dimensions: '1200x1600 (2.1 MB PNG)',
  rating: 'R15',
  tags: [
    { name: 'honoka_(dead_or_alive)', heading: 'Character' },
    { name: 'dead_or_alive', heading: 'Copyright' },
    { name: 'team_ninja', heading: 'Studio' },
    { name: 'flower', heading: 'Flora' },
    { name: 'official_art', heading: 'Medium' },
  ],
}, 'https://chan.sankakucomplex.com/en/posts/6Qa8Zo3plR9')
assert.equal(pageJob.media[0].url, 'https://s.sankakucomplex.com/o/aa/bb/aabb.png?e=1&m=x')
assert.equal(pageJob.media[0].width, 1200)
assert.equal(pageJob.media[0].height, 1600)
assert.equal(pageJob.media[0].safety, 'sketchy')
assert.equal(pageJob.media[0].referer, 'https://sankaku.app/')
assert.deepEqual(pageJob.media[0].tagCategories, {
  'honoka_(dead_or_alive)': 'character',
  dead_or_alive: 'copyright',
  team_ninja: 'artist',
  flower: 'general',
  official_art: 'meta',
  sankaku_6qa8zo3plr9: 'meta',
})
assert.equal(core.sankakuHeadingCategory('Series'), 'copyright')
assert.equal(core.sankakuHeadingCategory('Characters:'), 'character')
assert.equal(core.sankakuPageSafety('G'), 'safe')
assert.equal(core.sankakuPageSafety('R18'), 'unsafe')
assert.throws(
  () => core.sankakuPageImportJob({ originalUrl: '' }, 'https://chan.sankakucomplex.com/en/posts/6Qa8Zo3plR9'),
  /logged-in users/,
)

// Download progress for slow sources.
assert.equal(
  core.downloadProgressText({ received: 12.3 * 1048576, total: 36 * 1048576 }, 70000),
  'Downloading original… 12.3 / 36.0 MB (34%) · 180 KB/s · 70s',
)
assert.equal(core.downloadProgressText({ received: 0, total: null }, 400), 'Downloading original… 0.0 MB · 0s')
assert.equal(
  core.downloadProgressText({ received: 2 * 1048576, total: null }, 4000),
  'Downloading original… 2.0 MB · 512 KB/s · 4s',
)

// Sankaku's share / reaction / flag row: find the flag to put the cat after.
function iconControl(label, parent, attrs = {}) {
  const icon = { getAttribute: (name) => attrs[`icon:${name}`] || null }
  const node = {
    textContent: '',
    title: attrs.title || '',
    dataset: {},
    parentElement: parent,
    getAttribute: (name) => (name === 'aria-label' ? label : (attrs[name] || null)),
    querySelector: (selector) => (/svg|img|use/.test(selector) ? icon : null),
    contains: (other) => other === node,
  }
  return node
}
const sankakuRow = { contains: () => true }
const sankakuShare = iconControl('Share', sankakuRow)
const sankakuReact = iconControl('', sankakuRow)
const sankakuFlag = iconControl('', sankakuRow, { 'icon:class': 'icon-flag' })
assert.equal(core.selectSankakuFlagControl([sankakuShare, sankakuReact, sankakuFlag]), sankakuFlag)
const reportButton = iconControl('Report post', sankakuRow)
assert.equal(core.selectSankakuFlagControl([sankakuShare, sankakuReact, reportButton]), reportButton)
// Unlabelled flag: the last icon in the Share control's row.
const unlabelledFlag = iconControl('', sankakuRow)
assert.equal(core.selectSankakuFlagControl([sankakuShare, sankakuReact, unlabelledFlag]), unlabelledFlag)
assert.equal(core.selectSankakuFlagControl([sankakuReact]), null)

console.log('site-import-core tests passed')

// Danbooru: host and post ID parsing.
assert.equal(core.danbooruPostId('https://danbooru.donmai.us/posts/12367727'), '12367727')
assert.equal(core.danbooruPostId('https://danbooru.donmai.us/posts/12367727?q=seitokai'), '12367727')
assert.equal(core.danbooruPostId('https://safebooru.donmai.us/posts/5'), '5')
assert.equal(core.danbooruPostId('https://danbooru.donmai.us/posts?tags=touhou'), '')
assert.equal(core.danbooruPostId('https://danbooru.donmai.us.evil.example/posts/5'), '')
assert.equal(core.isDanbooruHost('donmai.us.evil.example'), false)

// Danbooru: the post JSON becomes an original-file job with real categories.
const danbooruPost = {
  id: 12367727,
  file_ext: 'png',
  image_width: 2894,
  image_height: 4093,
  rating: 'q',
  file_url: 'https://cdn.donmai.us/original/26/87/26874a9f65cc2288731dfe54850401ac.png',
  large_file_url: 'https://cdn.donmai.us/sample/26/87/sample-26874a9f65cc2288731dfe54850401ac.jpg',
  tag_string_artist: 'reim1k',
  tag_string_copyright: 'seitokai_ni_mo_ana_wa_aru!',
  tag_string_character: 'michinoku_komaro',
  tag_string_general: '1girl pink_hair',
  tag_string_meta: 'highres',
}
const danbooruJob = core.danbooruImportJob(danbooruPost, 'https://danbooru.donmai.us/posts/12367727')
assert.equal(danbooruJob.kind, 'danbooru')
assert.equal(danbooruJob.groupTag, 'danbooru_12367727')
assert.equal(danbooruJob.canonicalUrl, 'https://danbooru.donmai.us/posts/12367727')
assert.equal(danbooruJob.media[0].url, danbooruPost.file_url)
assert.equal(danbooruJob.media[0].type, 'image')
assert.equal(danbooruJob.media[0].width, 2894)
assert.equal(danbooruJob.media[0].safety, 'sketchy')
assert.equal(danbooruJob.media[0].tagCategories['seitokai_ni_mo_ana_wa_aru!'], 'copyright')
assert.equal(danbooruJob.media[0].tagCategories.michinoku_komaro, 'character')
assert.equal(danbooruJob.media[0].tagCategories.reim1k, 'artist')
assert.equal(danbooruJob.media[0].tagCategories.highres, 'meta')
assert.equal(danbooruJob.media[0].tagCategories.danbooru_12367727, 'meta')
assert.deepEqual(danbooruJob.media[0].tagDisplayNames, { 'seitokai_ni_mo_ana_wa_aru!': 'seitokai ni mo ana wa aru!' })

// Videos keep the original; ugoira (a zip of frames) takes Danbooru's webm.
const videoJob = core.danbooruImportJob({ ...danbooruPost, file_ext: 'mp4', file_url: 'https://cdn.donmai.us/original/26/87/x.mp4' }, 'https://danbooru.donmai.us/posts/12367727')
assert.equal(videoJob.media[0].type, 'video')
assert.equal(videoJob.media[0].url, 'https://cdn.donmai.us/original/26/87/x.mp4')
const danbooruUgoiraJob = core.danbooruImportJob({ ...danbooruPost, file_ext: 'zip', file_url: 'https://cdn.donmai.us/original/75/39/y.zip', large_file_url: 'https://cdn.donmai.us/sample/75/39/sample-y.webm' }, 'https://danbooru.donmai.us/posts/12367727')
assert.equal(danbooruUgoiraJob.media[0].type, 'video')
assert.equal(danbooruUgoiraJob.media[0].url, 'https://cdn.donmai.us/sample/75/39/sample-y.webm')

// A Gold-only post seen logged out has no file_url: say how to fix it.
assert.throws(() => core.danbooruImportJob({ ...danbooruPost, file_url: undefined }, 'https://danbooru.donmai.us/posts/12367727'), /Log in to Danbooru/)
assert.throws(() => core.danbooruImportJob({ ...danbooruPost, id: 1 }, 'https://danbooru.donmai.us/posts/12367727'), /did not return this post/)

// The background's re-check: same post, trusted CDN, display names rebuilt.
const sanitizedDanbooru = core.sanitizeDanbooruImportJob(danbooruJob, 'https://danbooru.donmai.us/posts/12367727')
assert.equal(sanitizedDanbooru.media[0].url, danbooruPost.file_url)
assert.equal(sanitizedDanbooru.media[0].referer, 'https://danbooru.donmai.us/')
assert.equal(sanitizedDanbooru.media[0].tagCategories['seitokai_ni_mo_ana_wa_aru!'], 'copyright')
assert.equal(sanitizedDanbooru.media[0].tagDisplayNames['seitokai_ni_mo_ana_wa_aru!'], 'seitokai ni mo ana wa aru!')
assert.throws(() => core.sanitizeDanbooruImportJob(danbooruJob, 'https://danbooru.donmai.us/posts/1'), /mismatch/)
const evilDanbooru = structuredClone(danbooruJob)
evilDanbooru.media[0].url = 'https://evil.example/original/x.png'
assert.throws(() => core.sanitizeDanbooruImportJob(evilDanbooru, 'https://danbooru.donmai.us/posts/12367727'), /trusted original/)
const httpDanbooru = structuredClone(danbooruJob)
httpDanbooru.media[0].url = 'http://cdn.donmai.us/original/26/87/x.png'
assert.throws(() => core.sanitizeDanbooruImportJob(httpDanbooru, 'https://danbooru.donmai.us/posts/12367727'), /trusted original/)

// AI stays off for Danbooru imports, as for Gelbooru.
const danbooruBody = core.siteImportPostBody(sanitizedDanbooru, sanitizedDanbooru.media[0], 'tok')
assert.equal(danbooruBody.autoTag, false)
assert.equal(danbooruBody.source, 'https://danbooru.donmai.us/posts/12367727')
assert.deepEqual(danbooruBody.tagDisplayNames, { 'seitokai_ni_mo_ana_wa_aru!': 'seitokai ni mo ana wa aru!' })

// Placement in the sidebar Options list.
function fakeDoc(ids) {
  const list = { id: 'list' }
  const nodes = Object.fromEntries(ids.map((id) => [id, { id, parentElement: list }]))
  return {
    list,
    querySelector: (selector) => selector === '#post-options ul' ? list : (nodes[selector.slice(1)] || null),
  }
}
const loggedIn = fakeDoc(['post-option-download', 'post-option-add-to-favorites', 'post-option-remove-from-favorites'])
assert.equal(core.selectDanbooruOptionsAnchor(loggedIn).after.id, 'post-option-remove-from-favorites')
assert.equal(core.selectDanbooruOptionsAnchor(fakeDoc(['post-option-download'])).after.id, 'post-option-download')
assert.equal(core.selectDanbooruOptionsAnchor(fakeDoc([])).after, null)
assert.equal(core.selectDanbooruOptionsAnchor({ querySelector: () => null }), null)

console.log('danbooru site-import tests passed')
assert.deepEqual(
  core.danbooruImportJob({ ...danbooruPost, tag_string_general: '? @_@ ^_^ pink_hair' }, 'https://danbooru.donmai.us/posts/12367727').media[0].tagDisplayNames,
  { 'seitokai_ni_mo_ana_wa_aru!': 'seitokai ni mo ana wa aru!' },
)
console.log('danbooru display-name tests passed')

// Placement right of "Recommended" in the tabs under the post.
function fakeSections(links) {
  const list = { id: 'post-sections-list' }
  const anchors = links.map(([href, text]) => {
    const li = { id: `li-${text}`, parentElement: list }
    return { getAttribute: () => href, textContent: text, closest: () => li, li }
  })
  return { anchors, list, querySelectorAll: (sel) => (sel === '#post-sections a' ? anchors : []) }
}
const sectionsDoc = fakeSections([['#comments', 'Comments'], ['#recommended', 'Recommended']])
const sectionsAnchor = core.selectDanbooruSectionsAnchor(sectionsDoc)
assert.equal(sectionsAnchor.after, sectionsDoc.anchors[1].li)
assert.equal(sectionsAnchor.list, sectionsDoc.list)
assert.equal(core.selectDanbooruSectionsAnchor(fakeSections([['#x', ' Recommended ']])).after.id, 'li- Recommended ')
assert.equal(core.selectDanbooruSectionsAnchor(fakeSections([['#comments', 'Comments']])), null)
assert.equal(core.selectDanbooruSectionsAnchor({ querySelectorAll: () => [] }), null)
console.log('danbooru sections placement tests passed')

// Danbooru search pages: which pages count, and the batch they become.
assert.deepEqual(core.danbooruSearchPage('https://danbooru.donmai.us/posts?tags=templus&page=2'), { tags: 'templus', page: '2' })
assert.deepEqual(core.danbooruSearchPage('https://danbooru.donmai.us/'), { tags: '', page: '1' })
assert.equal(core.danbooruSearchPage('https://danbooru.donmai.us/posts/12367727'), null)
assert.equal(core.danbooruSearchPage('https://danbooru.donmai.us/artists/1'), null)
assert.equal(core.danbooruSearchPage('https://danbooru.donmai.us.evil.example/posts?tags=x'), null)
assert.equal(core.danbooruSearchGroupQuery('templus rating:g -comic order:score ~a azur_lane'), 'templus azur_lane')

const searchPosts = [
  { ...danbooruPost, id: 2, file_url: 'https://cdn.donmai.us/original/aa/bb/two.png' },
  { ...danbooruPost, id: 1, file_url: 'https://cdn.donmai.us/original/aa/bb/one.png' },
  { ...danbooruPost, id: 3, file_url: undefined },
]
const searchJob = core.danbooruSearchImportJob(searchPosts, ['1', '2', '3', '4'], 'https://danbooru.donmai.us/posts?tags=templus&page=2')
assert.equal(searchJob.kind, 'danbooru_search')
assert.equal(searchJob.postId, 'templus|2')
assert.equal(searchJob.groupTag, 'templus')
assert.deepEqual(searchJob.media.map((item) => item.postId), ['1', '2'])
assert.deepEqual(searchJob.media.map((item) => item.index), [0, 1])
assert.equal(searchJob.media[0].url, 'https://cdn.donmai.us/original/aa/bb/one.png')
assert.ok(searchJob.media[0].tags.includes('danbooru_1'))
assert.deepEqual(searchJob.unavailable.map((entry) => entry.postId), ['3', '4'])
assert.match(searchJob.unavailable[0].reason, /Log in to Danbooru/)

const cleanSearch = core.sanitizeDanbooruSearchImportJob(searchJob, 'https://danbooru.donmai.us/posts?tags=templus&page=2')
assert.deepEqual(cleanSearch.media.map((item) => item.postId), ['1', '2'])
assert.equal(cleanSearch.media[1].source, 'https://danbooru.donmai.us/posts/2')
assert.equal(cleanSearch.media[1].tagCategories.danbooru_2, 'meta')
assert.throws(() => core.sanitizeDanbooruSearchImportJob(searchJob, 'https://danbooru.donmai.us/posts?tags=other'), /mismatch/)
const evilSearch = structuredClone(searchJob)
evilSearch.media[0].url = 'https://evil.example/original/x.png'
assert.throws(() => core.sanitizeDanbooruSearchImportJob(evilSearch, 'https://danbooru.donmai.us/posts?tags=templus&page=2'), /trusted original/)

// Placement right of "Posts | Artist".
const artistLink = { id: 'show-excerpt-link', parentElement: { id: 'li' } }
const postsLink = { id: 'show-posts-link', parentElement: { id: 'li' } }
assert.equal(core.selectDanbooruSearchAnchor({ querySelector: (s) => (s.endsWith('#show-excerpt-link') ? artistLink : postsLink) }).after, artistLink)
assert.equal(core.selectDanbooruSearchAnchor({ querySelector: (s) => (s.endsWith('#show-posts-link') ? postsLink : null) }).after, postsLink)
assert.equal(core.selectDanbooruSearchAnchor({ querySelector: () => null }), null)
console.log('danbooru search-page tests passed')

// Gelbooru search pages: the site's pid is a post offset.
assert.deepEqual(core.gelbooruSearchPage('https://gelbooru.com/index.php?page=post&s=list&tags=templus&pid=84'), { tags: 'templus', offset: 84 })
assert.deepEqual(core.gelbooruSearchPage('https://gelbooru.com/index.php?page=post&s=list&tags=all'), { tags: '', offset: 0 })
assert.equal(core.gelbooruSearchPage('https://gelbooru.com/index.php?page=post&s=view&id=1'), null)
assert.equal(core.gelbooruSearchPage('https://gelbooru.com.evil.example/index.php?page=post&s=list&tags=x'), null)

const gelSearchJob = core.gelbooruSearchImportJob(['5', '3', 'x', '5'], 'https://gelbooru.com/index.php?page=post&s=list&tags=templus+rating:general&pid=84')
assert.equal(gelSearchJob.kind, 'gelbooru_search')
assert.equal(gelSearchJob.postId, 'templus rating:general|84')
assert.deepEqual(gelSearchJob.ids, ['5', '3'])
assert.equal(gelSearchJob.offset, 84)
assert.equal(gelSearchJob.groupTag, 'templus')
assert.match(gelSearchJob.title, /page 3/)
assert.throws(() => core.gelbooruSearchImportJob([], 'https://gelbooru.com/index.php?page=post&s=list&tags=x'), /No posts/)

assert.deepEqual(
  core.sanitizeGelbooruSearchImportJob({ ...gelSearchJob, ids: [...gelSearchJob.ids, '../evil'] }, 'https://gelbooru.com/index.php?page=post&s=list&tags=templus+rating:general&pid=84').ids,
  ['5', '3'],
)
assert.throws(() => core.sanitizeGelbooruSearchImportJob(gelSearchJob, 'https://gelbooru.com/index.php?page=post&s=list&tags=templus'), /mismatch/)

const gelMedia = core.gelbooruSearchMedia({ posts: [
  { postId: 5, fileUrl: 'https://img4.gelbooru.com/images/aa/bb/5.png', postUrl: 'https://gelbooru.com/index.php?page=post&s=view&id=5', tags: ['templus', 'k-on!', 'gelbooru_5'], tagCategories: { templus: 'artist' }, safety: 'sketchy', width: 10, height: 20 },
  { postId: 3, fileUrl: 'https://video-cdn3.gelbooru.com/images/aa/bb/3.mp4', postUrl: 'u', tags: [], safety: 'bogus' },
] })
assert.equal(gelMedia[0].idTag, 'gelbooru_5')
assert.equal(gelMedia[0].label, 'Gelbooru #5')
assert.equal(gelMedia[0].type, 'image')
assert.equal(gelMedia[0].safety, 'sketchy')
assert.deepEqual(gelMedia[0].tagDisplayNames, { 'k-on!': 'k-on!' })
assert.equal(gelMedia[1].type, 'video')
assert.equal(gelMedia[1].safety, 'safe')
assert.deepEqual(gelMedia.map((item) => item.index), [0, 1])
console.log('gelbooru search-page tests passed')
