// Import a booru post's own tags when the download came from one.
//
// Loaded both by the popup (upload.html) and by the service worker
// (background.js, via importScripts), so everything here must stay free of
// window/document at load time and free of chrome.* outside the helpers that
// obviously need it.
//
// Two ways in, in this order:
//
//   1. The tab the user right-clicked. Its sidebar already lists every tag with
//      a category class, it costs no request, and it works while logged in.
//      This is the only route that works for Gelbooru at all - its JSON API
//      answers 401 without an api_key/user_id pair we have no business asking
//      the user for.
//   2. The site's JSON API, by post id from the URL. Used when the DOM route
//      finds nothing: the tab was closed, the markup moved, or the popup was
//      opened from somewhere else.

const BOORU_CATEGORY_NAMES = ['general', 'artist', 'copyright', 'character', 'meta']

// Gelbooru-engine and Moebooru JSON HTML-escape tag text ('girls&#039;_frontline');
// html-entities.js, loaded before this file, owns the decoder.
const booruDecodeEntities = (globalThis.NekoBooruEntities || require('./html-entities.js')).decodeHtmlEntities

// Danbooru's numeric tag categories, which every clone in this file reuses:
// 0 general, 1 artist, 2 (unused/deprecated), 3 copyright, 4 character,
// 5 meta. Gelbooru-family boards put the same numbers in `type`.
const BOORU_TYPE_TO_CATEGORY = {
  0: 'general',
  1: 'artist',
  3: 'copyright',
  4: 'character',
  5: 'meta',
  6: 'meta',
}

// e621 splits further than we do; species/lore have no local equivalent, so
// they land as general rather than inventing categories the UI cannot colour.
const E621_GROUP_TO_CATEGORY = {
  general: 'general',
  species: 'general',
  character: 'character',
  copyright: 'copyright',
  artist: 'artist',
  meta: 'meta',
  lore: 'general',
  invalid: null,
}

const BOORU_SITES = [
  {
    id: 'danbooru',
    label: 'Danbooru',
    // danbooru.donmai.us, safebooru.donmai.us, betabooru.donmai.us
    matches: (host) => host === 'donmai.us' || host.endsWith('.donmai.us'),
    postId: (url) => {
      const match = url.pathname.match(/^\/posts\/(\d+)/)
      return match ? match[1] : ''
    },
    apiUrl: (url, id) => `${url.origin}/posts/${id}.json`,
    parse: parseDanbooruJson,
  },
  {
    id: 'e621',
    label: 'e621',
    matches: (host) => host === 'e621.net' || host === 'e926.net',
    postId: (url) => {
      const match = url.pathname.match(/^\/posts\/(\d+)/)
      return match ? match[1] : ''
    },
    apiUrl: (url, id) => `${url.origin}/posts/${id}.json`,
    parse: parseE621Json,
  },
  {
    id: 'moebooru',
    label: 'Moebooru',
    matches: (host) => host === 'yande.re' || host === 'konachan.com' || host === 'konachan.net',
    postId: (url) => {
      const match = url.pathname.match(/^\/post\/show\/(\d+)/)
      return match ? match[1] : ''
    },
    apiUrl: (url, id) => `${url.origin}/post.json?tags=id:${id}`,
    parse: parseMoebooruJson,
  },
  {
    id: 'gelbooru',
    label: 'Gelbooru-style',
    // gelbooru.com plus the clones that share its dapi shape and markup.
    matches: (host) => host.endsWith('.gelbooru.com') || [
      'gelbooru.com',
      'safebooru.org',
      'rule34.xxx',
      'tbib.org',
      'xbooru.com',
      'realbooru.com',
      'hypnohub.net',
    ].includes(host),
    postId: (url) => {
      if (url.searchParams.get('page') !== 'post') return ''
      return /^\d+$/.test(url.searchParams.get('id') || '') ? url.searchParams.get('id') : ''
    },
    apiUrl: (url, id) =>
      `${url.origin}/index.php?page=dapi&s=post&q=index&json=1&id=${encodeURIComponent(id)}`,
    parse: parseGelbooruJson,
    // Gelbooru itself rejects the call; the clones answer it fine.
    apiNeedsCredentials: (host) => host === 'gelbooru.com' || host.endsWith('.gelbooru.com'),
  },
  {
    id: 'sankaku',
    label: 'Sankaku',
    // Classic Sankaku Channel and sankaku.app share one API and post IDs.
    matches: (host) => ['sankaku.app', 'chan.sankakucomplex.com', 'sankakucomplex.com'].includes(host),
    postId: (url) => {
      const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?posts\/([A-Za-z0-9]{1,32})\/?$/i)
      return match ? match[1] : ''
    },
    apiUrl: (_url, id) => `https://sankakuapi.com/posts/${encodeURIComponent(id)}`,
    parse: parseSankakuJson,
    // Its sidebar uses tag types the DOM scraper does not know (studio, genre,
    // medium), so the API is the better first answer; the DOM still covers
    // posts the API hides from anonymous requests.
    preferApi: true,
  },
]

function detectBooruPost(pageUrl) {
  let url
  try {
    url = new URL(pageUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  const site = BOORU_SITES.find((candidate) => candidate.matches(host))
  if (!site) return null
  const postId = site.postId(url)
  if (!postId) return null
  return {
    siteId: site.id,
    label: site.label,
    host,
    postId,
    apiUrl: site.apiUrl(url, postId),
    apiUsable: !(site.apiNeedsCredentials && site.apiNeedsCredentials(host)),
    preferApi: Boolean(site.preferApi),
    parse: site.parse,
  }
}

// Booru ratings are one letter on modern boards and a word on older ones.
function booruSafety(rating) {
  const value = String(rating || '').trim().toLowerCase()
  if (!value) return ''
  if (value === 'g' || value === 'general' || value === 's' || value === 'safe' || value === 'sensitive') {
    return value === 's' || value === 'sensitive' ? 'sketchy' : 'safe'
  }
  if (value === 'q' || value === 'questionable') return 'sketchy'
  if (value === 'e' || value === 'explicit') return 'unsafe'
  return ''
}

// Booru tag names are already underscore-cased, but scraped ones arrive with
// the sidebar's decoration: a leading "?" info link, a trailing post count,
// stray whitespace, and non-breaking spaces.
function cleanBooruTagName(raw) {
  return String(raw || '')
    .replace(/ /g, ' ')
    .trim()
    .replace(/^[?+\-\s]+/, '')
    // The count is only ever a separate token after whitespace (every real
    // markup sample keeps it in its own element, never glued onto the tag).
    // A bare \s* here used to also eat a qualifier's own trailing digits, e.g.
    // an artist disambiguated by a numeric handle - "shiki_(kisikisi1007)"
    // lost its "1007)" because the count-stripper matched it with nothing to
    // its left. Requiring \s+ makes it only ever strip a genuinely separate
    // trailing count.
    .replace(/\s+\(?\d[\d,.kKmM]*\)?$/, '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase()
}

function addBooruTag(collected, name, category) {
  const tag = cleanBooruTagName(name)
  if (!tag) return
  const resolved = BOORU_CATEGORY_NAMES.includes(category) ? category : 'general'
  // First writer wins for general, but a real category always upgrades one:
  // scrapers can see the same tag twice (sidebar plus a header list).
  if (!(tag in collected) || (collected[tag] === 'general' && resolved !== 'general')) {
    collected[tag] = resolved
  }
}

function booruResult(collected, { siteId, label, rating, source }) {
  const tags = Object.keys(collected).sort()
  return {
    siteId,
    label,
    tags,
    categories: collected,
    safety: booruSafety(rating),
    source: source || '',
    counts: BOORU_CATEGORY_NAMES.reduce((memo, name) => {
      memo[name] = tags.filter((tag) => collected[tag] === name).length
      return memo
    }, {}),
  }
}

function parseDanbooruJson(payload, context) {
  const post = Array.isArray(payload) ? payload[0] : payload
  if (!post || typeof post !== 'object') return null
  const collected = {}
  const groups = {
    general: post.tag_string_general,
    artist: post.tag_string_artist,
    copyright: post.tag_string_copyright,
    character: post.tag_string_character,
    meta: post.tag_string_meta,
  }
  Object.entries(groups).forEach(([category, value]) => {
    String(value || '').split(/\s+/).forEach((name) => addBooruTag(collected, name, category))
  })
  if (!Object.keys(collected).length) return null
  return booruResult(collected, { ...context, rating: post.rating, source: post.source })
}

function parseE621Json(payload, context) {
  const post = payload && payload.post ? payload.post : payload
  if (!post || typeof post !== 'object' || !post.tags) return null
  const collected = {}
  Object.entries(post.tags).forEach(([group, names]) => {
    const category = E621_GROUP_TO_CATEGORY[group]
    if (!category) return
    ;(Array.isArray(names) ? names : []).forEach((name) => addBooruTag(collected, name, category))
  })
  if (!Object.keys(collected).length) return null
  return booruResult(collected, {
    ...context,
    rating: post.rating,
    source: (post.sources || [])[0] || '',
  })
}

function parseMoebooruJson(payload, context) {
  const post = Array.isArray(payload) ? payload[0] : payload
  if (!post || typeof post !== 'object') return null
  const collected = {}
  // Moebooru's post.json carries no per-tag category; the caller enriches
  // these from /tag.json when it can, and plain general tags are still a
  // better import than nothing.
  booruDecodeEntities(post.tags).split(/\s+/).forEach((name) => addBooruTag(collected, name, 'general'))
  if (!Object.keys(collected).length) return null
  return booruResult(collected, { ...context, rating: post.rating, source: post.source })
}

function parseGelbooruJson(payload, context) {
  const posts = Array.isArray(payload) ? payload : (payload && payload.post) || []
  const post = Array.isArray(posts) ? posts[0] : posts
  if (!post || typeof post !== 'object') return null
  const collected = {}
  booruDecodeEntities(post.tags).split(/\s+/).forEach((name) => addBooruTag(collected, name, 'general'))
  if (!Object.keys(collected).length) return null
  return booruResult(collected, { ...context, rating: post.rating, source: post.source })
}

// Sankaku's own tag types: 2 studio, 5 genre, 8 medium and 9 meta sit beside
// the Danbooru numbers. Studios read as the artist, the way Danbooru files them.
const SANKAKU_TYPE_TO_CATEGORY = {
  0: 'general',
  1: 'artist',
  2: 'artist',
  3: 'copyright',
  4: 'character',
  5: 'general',
  8: 'meta',
  9: 'meta',
}

// Sankaku's "s" is safe, not Gelbooru's "sensitive", so translate the letter
// before the shared rating mapping sees it.
const SANKAKU_RATING_NAMES = { s: 'safe', q: 'questionable', e: 'explicit' }

function parseSankakuJson(payload, context) {
  const post = Array.isArray(payload) ? payload[0] : payload
  if (!post || typeof post !== 'object') return null
  const collected = {}
  const rows = Array.isArray(post.tags) ? post.tags : []
  rows.forEach((row) => {
    addBooruTag(collected, row && (row.tagName || row.name_en || row.name), SANKAKU_TYPE_TO_CATEGORY[Number(row && row.type)])
  })
  if (!rows.length) (post.tag_names || []).forEach((name) => addBooruTag(collected, name, 'general'))
  if (!Object.keys(collected).length) return null
  const rating = String(post.rating || '').toLowerCase()
  return booruResult(collected, {
    ...context,
    rating: SANKAKU_RATING_NAMES[rating] || rating,
    source: post.source && /^https?:\/\//i.test(post.source) ? post.source : '',
  })
}

// Applies the tag types from a Gelbooru-style /s=tag lookup onto an already
// parsed result. Safebooru ignores json=1 on that endpoint and answers XML, so
// both shapes are handled.
function applyGelbooruTagTypes(result, payload) {
  if (!result || !payload) return result
  const rows = Array.isArray(payload) ? payload : payload.tag || []
  rows.forEach((row) => {
    const name = cleanBooruTagName(booruDecodeEntities(row && (row.name || row.tag)))
    const category = BOORU_TYPE_TO_CATEGORY[Number(row && row.type)]
    if (name && category && name in result.categories) result.categories[name] = category
  })
  result.counts = BOORU_CATEGORY_NAMES.reduce((memo, name) => {
    memo[name] = result.tags.filter((tag) => result.categories[tag] === name).length
    return memo
  }, {})
  return result
}

function parseGelbooruTagTypeXml(text) {
  const rows = []
  const pattern = /<tag\b[^>]*>/g
  let match
  while ((match = pattern.exec(String(text || ''))) !== null) {
    const name = /\bname="([^"]*)"/.exec(match[0])
    const type = /\btype="(\d+)"/.exec(match[0])
    if (name) rows.push({ name: name[1], type: type ? Number(type[1]) : 0 })
  }
  return rows
}

// Injected into the source tab, so it must be fully self-contained: no
// closure over anything in this file, and only the DOM to work with.
function scrapeBooruTagsFromPage() {
  const CATEGORY_BY_CLASS = {
    'tag-type-general': 'general',
    'tag-type-artist': 'artist',
    'tag-type-copyright': 'copyright',
    'tag-type-character': 'character',
    'tag-type-meta': 'meta',
    'tag-type-metadata': 'meta',
    'tag-type-model': 'character',
    'tag-type-species': 'general',
    'tag-type-lore': 'general',
    // Sankaku's extra types.
    'tag-type-studio': 'artist',
    'tag-type-genre': 'general',
    'tag-type-medium': 'meta',
    'tag-type-0': 'general',
    'tag-type-1': 'artist',
    'tag-type-3': 'copyright',
    'tag-type-4': 'character',
    'tag-type-5': 'meta',
    'category-general': 'general',
    'category-artist': 'artist',
    'category-copyright': 'copyright',
    'category-character': 'character',
    'category-meta': 'meta',
  }

  const rows = document.querySelectorAll('li[class*="tag-type-"], li[class*="category-"]')
  const found = []
  rows.forEach((row) => {
    let category = ''
    row.classList.forEach((name) => {
      if (!category && CATEGORY_BY_CLASS[name]) category = CATEGORY_BY_CLASS[name]
    })
    if (!category) return
    // Danbooru and e621 label the anchor. Gelbooru-family boards do not, and
    // their row opens with a "?" wiki link (…&s=list&search=…) that must not be
    // mistaken for the tag: match the search link's tags= instead.
    const anchors = Array.from(row.querySelectorAll('a'))
    const labelled = anchors.find((a) => a.classList.contains('search-tag') || a.dataset?.tagName)
    const anchor =
      labelled ||
      anchors.find((a) => /[?&]tags=/.test(a.getAttribute('href') || '') && a.textContent.trim() !== '?') ||
      anchors.find((a) => a.textContent.trim() && a.textContent.trim() !== '?')
    if (!anchor) return
    const name = anchor.dataset?.tagName || anchor.textContent || ''
    if (name) found.push({ name, category })
  })

  const ratingText = (document.body.textContent.match(/Rating:\s*([A-Za-z]+)/) || [])[1] || ''
  return { tags: found, rating: ratingText }
}

function resultFromScrape(scraped, context) {
  if (!scraped || !Array.isArray(scraped.tags) || !scraped.tags.length) return null
  const collected = {}
  scraped.tags.forEach((entry) => addBooruTag(collected, entry.name, entry.category))
  if (!Object.keys(collected).length) return null
  return booruResult(collected, { ...context, rating: scraped.rating, source: '' })
}

// Site-specific content scripts use the same tested DOM scraper as the normal
// right-click import flow. Exposing a narrow helper avoids duplicating the
// Gelbooru-family sidebar parser in each injected script.
const booruTagApi = {
  detectBooruPost,
  booruSafety,
  cleanBooruTagName,
  parseDanbooruJson,
  parseE621Json,
  parseMoebooruJson,
  parseGelbooruJson,
  parseSankakuJson,
  applyGelbooruTagTypes,
  parseGelbooruTagTypeXml,
  resultFromScrape,
  scrapeBooruTagsFromPage,
}
if (typeof globalThis !== 'undefined') globalThis.NekoBooruBooruTags = booruTagApi
if (typeof module !== 'undefined' && module.exports) module.exports = booruTagApi
