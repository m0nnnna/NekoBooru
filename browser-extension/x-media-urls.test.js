// X attachment resolution, exercised against a real tweet:
// x.com/BlueWaifu/status/2095853665160425960 carries three animated GIFs, and
// X numbers them /photo/1../photo/3 even though each one is served as an mp4.
// That combination is what used to make every "download /photo/2" hand back
// the tweet's first attachment, so the fixtures below mirror it exactly.
//
// The helpers exist once per entry point (service worker, content script,
// upload popup) because none of them share a bundle, so each copy is pulled
// straight out of its own source file (background-x-media.js, track-cursor-x.js,
// upload-media-fetch.js) and checked against the others.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function functionSource(source, name) {
  let start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} is missing`)
  // Keep an `async` prefix, or the extracted copy cannot use await.
  if (source.slice(start - 6, start) === 'async ') start -= 6
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unterminated ${name}`)
}

// Evaluate the named helpers in isolation. `extras` stands in for the globals
// their host file would have.
function loadHelpers(file, names, extras = {}) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
  const context = vm.createContext({ URL, Number, Array, Math, Set, String, ...extras })
  vm.runInContext(names.map((name) => functionSource(source, name)).join('\n\n'), context)
  return Object.fromEntries(names.map((name) => [name, context[name]]))
}

const TWEET = 'https://x.com/BlueWaifu/status/2095853665160425960'
const OTHER = 'https://x.com/someone/status/111'
const GIF = [
  'https://video.twimg.com/tweet_video/HRX3yxWbAAAKy0_.mp4',
  'https://video.twimg.com/tweet_video/HRX3ytfWwAEJz21.mp4',
  'https://video.twimg.com/tweet_video/HRX3yt8aIAAcKgH.mp4',
]

const background = loadHelpers('background-x-media.js', [
  'tweetIdFromUrl',
  'xMediaIndexFromUrl',
  'withXMediaIndexPath',
  'isTwitterCdnMediaUrl',
  'xAttachmentFromClick',
  'normalizeUploadSrcUrl',
  'normalizeMediaList',
])
const upload = loadHelpers('upload-media-fetch.js', [
  'tweetIdFromUrl',
  'xMediaIndexFromUrl',
  'isTwitterMediaCdnUrl',
])
const cursor = loadHelpers(
  'track-cursor-x.js',
  ['normalizedStatusUrl', 'tweetIdFromUrl', 'xMediaIndexFromUrl', 'withLocationMediaIndex'],
  { isXHost: () => true, location: { origin: 'https://x.com', href: `${TWEET}/photo/2` } },
)

// capturedXAttachment reads the module-level cache, so give it one.
const cache = new Map()
const captured = loadHelpers(
  'background-x-media.js',
  ['tweetIdFromUrl', 'xMediaIndexFromUrl', 'capturedXAttachment'],
  {
    xMediaCache: cache,
    loadXMediaCache: async () => {},
    getXMedia: (id) => cache.get(String(id))?.media || [],
  },
)
cache.set('2095853665160425960', {
  media: GIF.map((url, index) => ({ type: 'video', url, index })),
})

async function main() {
  // --- attachment index ----------------------------------------------------
  // The reported bug: the second attachment must not read as the first.
  assert.equal(background.xMediaIndexFromUrl(`${TWEET}/photo/2`), 1)
  assert.equal(background.xMediaIndexFromUrl(`${TWEET}/photo/1`), 0)
  assert.equal(background.xMediaIndexFromUrl(`${TWEET}/photo/3`), 2)
  // X uses /video/<n> for real videos and /photo/<n> for GIFs; both are indexes.
  assert.equal(background.xMediaIndexFromUrl(`${TWEET}/video/2`), 1)
  // No attachment in the URL means the index is unknown, not zero.
  assert.equal(background.xMediaIndexFromUrl(TWEET), null)
  assert.equal(background.xMediaIndexFromUrl('https://x.com/BlueWaifu'), null)
  assert.equal(background.xMediaIndexFromUrl('https://example.com/status/1/photo/2'), null)
  assert.equal(background.xMediaIndexFromUrl(''), null)
  assert.equal(background.xMediaIndexFromUrl('https://twitter.com/a/status/1/photo/3'), 2)

  // --- carrying the index across a status URL ------------------------------
  // A status URL read off the page is always bare; the address bar restores it.
  assert.equal(background.withXMediaIndexPath(TWEET, `${TWEET}/photo/2`), `${TWEET}/photo/2`)
  assert.equal(background.withXMediaIndexPath(TWEET, `${TWEET}/video/3`), `${TWEET}/video/3`)
  // An index the URL already carries wins over the address bar.
  assert.equal(background.withXMediaIndexPath(`${TWEET}/photo/3`, `${TWEET}/photo/2`), `${TWEET}/photo/3`)
  // A different tweet (a quoted post, a reply) must not borrow this page's index.
  assert.equal(background.withXMediaIndexPath(OTHER, `${TWEET}/photo/2`), OTHER)
  assert.equal(background.withXMediaIndexPath(TWEET, TWEET), TWEET)
  assert.equal(background.withXMediaIndexPath('', `${TWEET}/photo/2`), '')

  // --- what counts as directly fetchable X media ---------------------------
  assert.equal(background.isTwitterCdnMediaUrl(GIF[1]), true)
  assert.equal(background.isTwitterCdnMediaUrl('https://pbs.twimg.com/media/Gx1?format=jpg&name=orig'), true)
  // A real X video is an MSE blob, and an avatar is not tweet media.
  assert.equal(background.isTwitterCdnMediaUrl('blob:https://x.com/abc-123'), false)
  assert.equal(background.isTwitterCdnMediaUrl('https://pbs.twimg.com/profile_images/1/a.jpg'), false)
  assert.equal(background.isTwitterCdnMediaUrl('https://example.com/a.mp4'), false)
  // Both files must agree, or the popup re-routes what the worker already sent.
  const cdnCases = [
    GIF[1],
    'https://pbs.twimg.com/media/Gx1?format=jpg&name=orig',
    'blob:https://x.com/abc-123',
    'https://pbs.twimg.com/profile_images/1/a.jpg',
  ]
  for (const url of cdnCases) {
    assert.equal(upload.isTwitterMediaCdnUrl(url), background.isTwitterCdnMediaUrl(url), url)
  }

  // --- the click itself identifies a GIF -----------------------------------
  // Right-clicking the second GIF gives its own mp4, so no lookup is needed.
  const clicked = background.xAttachmentFromClick({ mediaType: 'video', srcUrl: GIF[1] })
  assert.equal(clicked?.url, GIF[1])
  assert.equal(clicked?.type, 'video')
  // A real video's src is a blob the server cannot fetch — leave it to yt-dlp.
  assert.equal(background.xAttachmentFromClick({ mediaType: 'video', srcUrl: 'blob:https://x.com/abc' }), null)
  // A still counts when nothing was playing under the pointer, so the reader
  // can right-click a specific slide even while the URL names another.
  const PHOTO3 = 'https://pbs.twimg.com/media/Gx3?format=jpg&name=orig'
  const still = background.xAttachmentFromClick({ mediaType: 'image', srcUrl: PHOTO3 }, false)
  assert.equal(still?.url, PHOTO3)
  assert.equal(still?.type, 'image')
  // Over a player the same <img> is only the poster frame.
  assert.equal(background.xAttachmentFromClick({ mediaType: 'image', srcUrl: PHOTO3 }, true), null)
  // A GIF's poster is not on the /media/ path at all.
  assert.equal(
    background.xAttachmentFromClick({
      mediaType: 'image',
      srcUrl: 'https://pbs.twimg.com/tweet_video_thumb/HRX3ytfWwAEJz21.jpg',
    }, false),
    null,
  )
  assert.equal(background.xAttachmentFromClick({}, false), null)

  // --- the captured tweet payload keeps X's own ordering -------------------
  const attachment = async (url) => (await captured.capturedXAttachment(url))?.url ?? null
  assert.equal(await attachment(`${TWEET}/photo/2`), GIF[1])
  assert.equal(await attachment(`${TWEET}/photo/1`), GIF[0])
  assert.equal(await attachment(`${TWEET}/photo/3`), GIF[2])
  // Without an index in the URL there is nothing to resolve — do not guess.
  assert.equal(await attachment(TWEET), null)
  assert.equal(await attachment(`${OTHER}/photo/2`), null)
  // An index past the end must not wrap round to the first attachment.
  assert.equal(await attachment(`${TWEET}/photo/9`), null)

  // --- a page scrape must not relabel an attachment ------------------------
  // capturedXMediaFromPage records a null index when the URL does not say which
  // attachment was clicked. Merged into the cache, that entry must lose the
  // dedupe to the indexed copy rather than moving GIF 2 into position 0.
  const merged = background.normalizeMediaList([
    ...GIF.map((url, index) => ({ type: 'video', url, index })),
    { type: 'video', url: GIF[1], index: null },
  ])
  assert.deepEqual(merged.map((item) => item.url), GIF)
  assert.deepEqual(merged.map((item) => item.index), [0, 1, 2])

  // Media known only from the page still survives, just ordered last.
  const scraped = background.normalizeMediaList([
    { type: 'video', url: GIF[1], index: null },
    { type: 'video', url: GIF[0], index: 0 },
  ])
  assert.deepEqual(scraped.map((item) => item.url), [GIF[0], GIF[1]])

  // --- the three copies of the shared helpers agree ------------------------
  // The timestamp link is always bare, so the lightbox's index has to come from
  // the page the reader is on.
  assert.equal(cursor.withLocationMediaIndex(TWEET), `${TWEET}/photo/2`)
  assert.equal(cursor.withLocationMediaIndex(`${TWEET}/photo/3`), `${TWEET}/photo/3`)
  assert.equal(cursor.withLocationMediaIndex(OTHER), OTHER)
  assert.equal(cursor.withLocationMediaIndex(''), '')

  for (const url of [`${TWEET}/photo/2`, `${TWEET}/video/2`, TWEET, `${TWEET}/photo/1`]) {
    assert.equal(upload.xMediaIndexFromUrl(url), background.xMediaIndexFromUrl(url), url)
    assert.equal(cursor.xMediaIndexFromUrl(url), background.xMediaIndexFromUrl(url), url)
    assert.equal(upload.tweetIdFromUrl(url), background.tweetIdFromUrl(url), url)
    assert.equal(cursor.tweetIdFromUrl(url), background.tweetIdFromUrl(url), url)
  }

  // --- which X responses get captured --------------------------------------
  // The matcher lives inside an IIFE, so read the literal out of the source.
  const captureSource = fs.readFileSync(path.join(__dirname, 'x-media-capture.js'), 'utf8')
  const literal = captureSource.match(/const CAPTURE_ENDPOINT = (\/.*\/)\n/)?.[1]
  assert.ok(literal, 'CAPTURE_ENDPOINT literal not found')
  const capture = new RegExp(literal.slice(1, -1))

  for (const captured of [
    '/i/api/graphql/aBc123/TweetDetail',
    '/graphql/aBc123/TweetDetail',
    // The old allow-list named fourteen operations; these are the kind of
    // rename or addition that used to fall through silently.
    '/i/api/graphql/aBc123/TweetDetailWithVisibilityResults',
    '/i/api/graphql/aBc123/NotificationsTimeline',
    '/i/api/graphql/aBc123/ConversationTimeline',
    // Direct messages come over REST, not GraphQL, so they never matched.
    '/i/api/1.1/dm/conversation/1569552145-2468.json',
    '/i/api/1.1/dm/inbox_initial_state.json',
    '/i/api/1.1/dm/user_updates.json',
    '/1.1/dm/conversation/1569552145-2468.json',
  ]) {
    assert.equal(capture.test(captured), true, captured)
  }

  for (const ignored of [
    '/i/api/1.1/jot/client_event.json',
    '/i/api/2/notifications/all.json',
    '/i/api/graphql/aBc123/TweetDetail/extra',
    '/home',
    '/BlueWaifu/status/2095853665160425960/photo/2',
  ]) {
    assert.equal(capture.test(ignored), false, ignored)
  }

  console.log('x-media-urls: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
