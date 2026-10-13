;(function installSiteImportCore(root) {
  function normalizeTag(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '')
  }

  function pixivArtworkId(raw) {
    try {
      const url = new URL(raw)
      if (url.hostname !== 'pixiv.net' && !url.hostname.endsWith('.pixiv.net')) return ''
      return url.pathname.match(/\/artworks\/(\d+)/)?.[1] || ''
    } catch {
      return ''
    }
  }

  // gelbooru.com and its language mirrors (ja.gelbooru.com) share post IDs and
  // markup, so an import can start from any of them.
  function isGelbooruHost(hostname) {
    const host = String(hostname || '').toLowerCase()
    return host === 'gelbooru.com' || host.endsWith('.gelbooru.com')
  }

  function gelbooruPostId(raw) {
    try {
      const url = new URL(raw)
      if (!isGelbooruHost(url.hostname) || url.searchParams.get('page') !== 'post') return ''
      const id = url.searchParams.get('id') || ''
      return /^\d+$/.test(id) ? id : ''
    } catch {
      return ''
    }
  }

  function safebooruPostId(raw) {
    try {
      const url = new URL(raw)
      const host = url.hostname.replace(/^www\./, '').toLowerCase()
      if (host !== 'safebooru.org' || url.searchParams.get('page') !== 'post') return ''
      const id = url.searchParams.get('id') || ''
      return /^\d+$/.test(id) ? id : ''
    } catch {
      return ''
    }
  }

  // danbooru.donmai.us and its mirrors (safebooru.donmai.us, ...) share post IDs.
  function isDanbooruHost(hostname) {
    const host = String(hostname || '').toLowerCase()
    return host === 'donmai.us' || host.endsWith('.donmai.us')
  }

  function danbooruPostId(raw) {
    try {
      const url = new URL(raw)
      if (!isDanbooruHost(url.hostname)) return ''
      return url.pathname.match(/^\/posts\/(\d+)(?:[/.]|$)/)?.[1] || ''
    } catch {
      return ''
    }
  }

  // Classic Sankaku Channel and the newer sankaku.app are two front-ends over
  // one API and one set of post IDs. Idol is a separate board and is excluded.
  function isSankakuHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '')
    return host === 'sankaku.app' || host === 'chan.sankakucomplex.com' || host === 'sankakucomplex.com'
  }

  // /posts/<id>, optionally under a language prefix (/en/posts/<id>). IDs are
  // case-sensitive alphanumeric strings; the API rejects the old numeric
  // /post/show/<id> ones, which sankakuLegacyPostUrl() redirects instead.
  function sankakuPostId(raw) {
    try {
      const url = new URL(raw)
      if (!isSankakuHost(url.hostname)) return ''
      const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?posts\/([A-Za-z0-9]{1,32})\/?$/i)
      return match ? match[1] : ''
    } catch {
      return ''
    }
  }

  // Old numeric post links (/post/show/4491595), which search engines like
  // SauceNAO still hand out, 404 on the current Sankaku Channel. Its
  // posts/similar page still accepts the numeric ID and finds the post.
  // Returns '' for anything that is not such a link.
  function sankakuLegacyPostUrl(raw) {
    try {
      const url = new URL(raw)
      const host = url.hostname.toLowerCase().replace(/^www\./, '')
      if (host !== 'chan.sankakucomplex.com' && host !== 'sankakucomplex.com') return ''
      const id = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?post\/show\/(\d+)\/?$/i)?.[1]
      return id ? `https://chan.sankakucomplex.com/posts/similar?id=${id}` : ''
    } catch {
      return ''
    }
  }

  // Sankaku's front-ends; every other *.sankakucomplex.com host serves media.
  // Mirrors _SANKAKU_FRONTEND_HOSTS in backend/app/routers/uploads.py.
  const SANKAKU_FRONTEND_HOSTS = new Set(['chan', 'www', 'idol', 'login', 'beta', 'legacy', 'black', 'white'])

  function isSankakuMediaHost(hostname) {
    const host = String(hostname || '').toLowerCase()
    if (!host.endsWith('.sankakucomplex.com')) return false
    return !SANKAKU_FRONTEND_HOSTS.has(host.slice(0, -'.sankakucomplex.com'.length))
  }

  // The CDN answers a chan.sankakucomplex.com referer with a hotlink
  // placeholder; sankaku.app's referer gets the real file.
  const SANKAKU_MEDIA_REFERER = 'https://sankaku.app/'

  // Sankaku's own letters: s is safe here, not Gelbooru's "sensitive".
  function sankakuSafety(raw) {
    const rating = String(raw || '').trim().toLowerCase()
    if (rating === 'e' || rating === 'explicit') return 'unsafe'
    if (rating === 'q' || rating === 'questionable') return 'sketchy'
    return 'safe'
  }

  // Sankaku tag types: 0 general, 1 artist, 2 studio, 3 copyright,
  // 4 character, 5 genre, 8 medium, 9 meta. Studios read as the artist, the way
  // Danbooru files animation studios.
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

  // The page's own session token, so logged-in users can import what Sankaku
  // hides from anonymous visitors. It is only ever sent back to Sankaku's API.
  function sankakuAccessToken(raw) {
    let token = String(raw || '').trim()
    if (token.startsWith('"')) {
      try { token = String(JSON.parse(token) || '') } catch { return '' }
    }
    return /^[A-Za-z0-9_\-.]{20,4096}$/.test(token) ? token : ''
  }

  // The original link a post page shows its viewer. Sankaku's API withholds
  // file_url from requests without the page's login (questionable and
  // explicit posts), but the page still links the original to a logged-in
  // viewer. Only a Sankaku media host over https is accepted.
  function sankakuOriginalFromPage(raw) {
    try {
      const url = new URL(raw)
      return url.protocol === 'https:' && isSankakuMediaHost(url.hostname) ? url.href : ''
    } catch {
      return ''
    }
  }

  function sankakuImportJob(payload, pageUrl, pageOriginalUrl = '') {
    const postId = sankakuPostId(pageUrl)
    if (!postId) throw new Error('Open a Sankaku post first.')
    const post = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
    if (String(post.id || '') !== postId) throw new Error('Sankaku did not return this post.')
    const fileUrl = String(post.file_url || '').trim() || sankakuOriginalFromPage(pageOriginalUrl)
    if (!/^https:\/\//i.test(fileUrl)) {
      throw new Error('Sankaku hides this original from logged-out visitors. Log in to Sankaku in this browser and try again.')
    }

    const rows = Array.isArray(post.tags) ? post.tags : []
    const tagEntries = rows.length
      ? rows.map((row) => ({
        name: row?.tagName || row?.name_en || row?.name,
        category: SANKAKU_TYPE_TO_CATEGORY[Number(row?.type)] || 'general',
      }))
      : (Array.isArray(post.tag_names) ? post.tag_names : []).map((name) => ({ name, category: 'general' }))
    return buildSankakuJob(postId, pageUrl, {
      fileUrl,
      type: /^video\//i.test(String(post.file_type || '')) ? 'video' : 'image',
      width: post.width,
      height: post.height,
      tagEntries,
      safety: sankakuSafety(post.rating),
    })
  }

  function buildSankakuJob(postId, pageUrl, { fileUrl, type, width, height, tagEntries, safety }) {
    const tags = []
    const tagCategories = {}
    const addTag = (raw, category) => {
      const tag = normalizeTag(raw)
      if (!tag) return
      if (!tags.includes(tag)) tags.push(tag)
      if (category) tagCategories[tag] = category
      else if (!tagCategories[tag]) tagCategories[tag] = 'general'
    }
    tagEntries.forEach((entry) => addTag(entry?.name, entry?.category))
    const idTag = normalizeTag(`sankaku_${postId}`)
    addTag(idTag, 'meta')
    const origin = new URL(pageUrl).origin
    const canonicalUrl = `${origin}/posts/${postId}`
    return {
      kind: 'sankaku',
      postId,
      title: `Sankaku ${postId}`,
      canonicalUrl,
      groupTag: idTag,
      media: [{
        type,
        url: fileUrl,
        referer: SANKAKU_MEDIA_REFERER,
        index: 0,
        width: width || null,
        height: height || null,
        source: canonicalUrl,
        tags,
        tagCategories,
        tagDisplayNames: {},
        safety,
      }],
    }
  }

  // Sidebar headings on a Sankaku post page, by what NekoBooru files them as.
  // Sankaku splits general tags into many themed groups (Flora, Setting,
  // Fashion, ...); anything not named here is general.
  const SANKAKU_HEADING_CATEGORIES = {
    artist: 'artist',
    studio: 'artist',
    copyright: 'copyright',
    franchise: 'copyright',
    series: 'copyright',
    character: 'character',
    medium: 'meta',
    meta: 'meta',
    automatic: 'meta',
    language: 'meta',
  }

  function sankakuHeadingCategory(text) {
    const key = String(text || '').trim().toLowerCase().replace(/[\s:]+$/, '')
    return SANKAKU_HEADING_CATEGORIES[key] || SANKAKU_HEADING_CATEGORIES[key.replace(/s$/, '')] || 'general'
  }

  // The page's rating badge: G / R15 / R18 now, s / q / e on older pages.
  function sankakuPageSafety(raw) {
    const rating = String(raw || '').trim().toLowerCase()
    if (['r18', 'e', 'explicit'].includes(rating)) return 'unsafe'
    if (['r15', 'q', 'questionable', 'sensitive'].includes(rating)) return 'sketchy'
    return 'safe'
  }

  // A post the API will not show an anonymous request, rebuilt from what the
  // logged-in page shows: its Original link, sidebar tags, and rating badge.
  function sankakuPageImportJob(page, pageUrl) {
    const postId = sankakuPostId(pageUrl)
    if (!postId) throw new Error('Open a Sankaku post first.')
    const fileUrl = sankakuOriginalFromPage(page?.originalUrl)
    if (!fileUrl) {
      throw new Error('Sankaku only shows this post to logged-in users, and this page shows no Original link. Log in to Sankaku and try again.')
    }
    const dimensions = String(page?.dimensions || '').match(/(\d+)\s*[x×]\s*(\d+)/)
    return buildSankakuJob(postId, pageUrl, {
      fileUrl,
      type: /\.(mp4|webm|mov|m4v)(\?|$)/i.test(new URL(fileUrl).pathname) ? 'video' : 'image',
      width: dimensions ? Number(dimensions[1]) : null,
      height: dimensions ? Number(dimensions[2]) : null,
      tagEntries: (Array.isArray(page?.tags) ? page.tags : []).map((entry) => ({
        name: entry?.name,
        category: sankakuHeadingCategory(entry?.heading),
      })),
      safety: sankakuPageSafety(page?.rating),
    })
  }

  const IMPORT_CATEGORIES = new Set(['general', 'artist', 'copyright', 'character', 'meta'])

  // The tag list and categories of a media item that crossed from a content
  // script, bounded and limited to categories NekoBooru knows.
  function sanitizedImportTags(item, idTag) {
    const tags = []
    for (const rawTag of Array.isArray(item?.tags) ? item.tags.slice(0, 500) : []) {
      const tag = normalizeTag(String(rawTag).slice(0, 200))
      if (tag && !tags.includes(tag)) tags.push(tag)
    }
    if (!tags.includes(idTag)) tags.push(idTag)
    const tagCategories = {}
    for (const [rawTag, rawCategory] of Object.entries(item?.tagCategories || {})) {
      const tag = normalizeTag(String(rawTag).slice(0, 200))
      const category = String(rawCategory || '')
      if (tag && tags.includes(tag) && IMPORT_CATEGORIES.has(category) && !['__proto__', 'constructor', 'prototype'].includes(tag)) {
        tagCategories[tag] = category
      }
    }
    tagCategories[idTag] = 'meta'
    return { tags, tagCategories }
  }

  function importDimension(value) {
    const number = Math.round(Number(value))
    return Number.isInteger(number) && number > 0 && number <= 100000 ? number : null
  }

  function sanitizeSankakuImportJob(raw, senderUrl) {
    const senderId = sankakuPostId(senderUrl)
    const job = raw && typeof raw === 'object' ? raw : {}
    if (!senderId || String(job.postId) !== senderId) throw new Error('Sankaku post ID mismatch.')
    const item = Array.isArray(job.media) ? job.media[0] : null
    const mediaUrl = new URL(item?.url || '')
    if (mediaUrl.protocol !== 'https:' || !isSankakuMediaHost(mediaUrl.hostname)) {
      throw new Error('Sankaku did not provide a trusted original URL.')
    }
    const idTag = normalizeTag(`sankaku_${senderId}`)
    const { tags, tagCategories } = sanitizedImportTags(item, idTag)
    const origin = new URL(senderUrl).origin
    const canonicalUrl = `${origin}/posts/${senderId}`
    return {
      kind: 'sankaku',
      postId: senderId,
      title: `Sankaku ${senderId}`,
      canonicalUrl,
      groupTag: idTag,
      media: [{
        type: item?.type === 'video' ? 'video' : 'image',
        url: mediaUrl.href,
        referer: SANKAKU_MEDIA_REFERER,
        index: 0,
        width: importDimension(item?.width),
        height: importDimension(item?.height),
        source: canonicalUrl,
        tags,
        tagCategories,
        tagDisplayNames: {},
        safety: ['safe', 'sketchy', 'unsafe'].includes(item?.safety) ? item.safety : 'safe',
      }],
    }
  }

  function booruImportSafety(raw) {
    const rating = String(raw || '').trim().toLowerCase()
    if (rating === 'e' || rating === 'explicit') return 'unsafe'
    return ['q', 'questionable', 's', 'sensitive'].includes(rating) ? 'sketchy' : 'safe'
  }

  // The Gelbooru engine's dapi JSON HTML-escapes text ('girls&#039;_frontline',
  // '&gt;_&lt;'); html-entities.js owns the decoder.
  const { decodeHtmlEntities: decodeEntities } = root.NekoBooruEntities || require('./html-entities.js')

  function safebooruImportJob(payload, scraped, pageUrl, fallbackOriginalUrl = '') {
    const postId = safebooruPostId(pageUrl)
    if (!postId) throw new Error('Open a Safebooru post first.')
    const posts = Array.isArray(payload) ? payload : (payload?.post || [])
    const post = Array.isArray(posts) ? (posts[0] || {}) : (posts || {})
    const fileUrl = String(post.file_url || fallbackOriginalUrl || '').trim()
    if (!/^https:\/\//i.test(fileUrl)) throw new Error('Safebooru did not provide an original image URL.')

    const tags = []
    const tagCategories = {}
    const addTag = (raw, category = 'general') => {
      const tag = normalizeTag(raw)
      if (!tag) return
      if (!tags.includes(tag)) tags.push(tag)
      if (IMPORT_CATEGORIES.has(category)) tagCategories[tag] = category
      else if (!tagCategories[tag]) tagCategories[tag] = 'general'
    }
    decodeEntities(post.tags).split(/\s+/).forEach((tag) => addTag(tag))
    for (const entry of Array.isArray(scraped?.tags) ? scraped.tags : []) {
      addTag(entry?.name, entry?.category)
    }

    const idTag = `safebooru_${postId}`
    addTag(idTag, 'meta')
    const canonicalUrl = `https://safebooru.org/index.php?page=post&s=view&id=${postId}`
    return {
      kind: 'safebooru',
      postId,
      title: `Safebooru #${postId}`,
      canonicalUrl,
      groupTag: idTag,
      media: [{
        type: 'image',
        url: fileUrl,
        referer: 'https://safebooru.org/',
        index: 0,
        width: post.width || null,
        height: post.height || null,
        source: canonicalUrl,
        tags,
        tagCategories,
        tagDisplayNames: booruDisplayNames(tags),
        safety: booruImportSafety(post.rating || scraped?.rating),
      }],
    }
  }

  function sanitizeSafebooruImportJob(raw, senderUrl) {
    const senderId = safebooruPostId(senderUrl)
    const job = raw && typeof raw === 'object' ? raw : {}
    if (!senderId || String(job.postId) !== senderId) throw new Error('Safebooru post ID mismatch.')
    const item = Array.isArray(job.media) ? job.media[0] : null
    const mediaUrl = new URL(item?.url || '')
    const mediaHost = mediaUrl.hostname.replace(/^www\./, '').toLowerCase()
    if (mediaUrl.protocol !== 'https:' || mediaHost !== 'safebooru.org' || !/^\/+images\//i.test(mediaUrl.pathname)) {
      throw new Error('Safebooru did not provide a trusted original URL.')
    }

    const idTag = `safebooru_${senderId}`
    const { tags, tagCategories } = sanitizedImportTags(item, idTag)
    const canonicalUrl = `https://safebooru.org/index.php?page=post&s=view&id=${senderId}`
    return {
      kind: 'safebooru',
      postId: senderId,
      title: `Safebooru #${senderId}`,
      canonicalUrl,
      groupTag: idTag,
      media: [{
        type: 'image',
        url: mediaUrl.href,
        referer: 'https://safebooru.org/',
        index: 0,
        width: importDimension(item?.width),
        height: importDimension(item?.height),
        source: canonicalUrl,
        tags,
        tagCategories,
        tagDisplayNames: booruDisplayNames(tags),
        safety: ['safe', 'sketchy', 'unsafe'].includes(item?.safety) ? item.safety : 'safe',
      }],
    }
  }

  function pixivSafety(meta) {
    const restriction = Number(meta?.xRestrict || 0)
    return restriction > 0 ? 'unsafe' : 'safe'
  }

  function translatedPixivTag(entry) {
    const translated = entry?.translation?.en || entry?.translation?.en_us || ''
    return normalizeTag(translated || entry?.tag || '')
  }

  function pixivImportJob(metaPayload, pagesPayload, pageUrl, ugoiraPayload = null) {
    const artworkId = pixivArtworkId(pageUrl)
    if (!artworkId) throw new Error('This is not a Pixiv artwork page.')
    if (metaPayload?.error || pagesPayload?.error) {
      throw new Error(metaPayload?.message || pagesPayload?.message || 'Pixiv did not return this artwork.')
    }
    const meta = metaPayload?.body || metaPayload || {}
    const pages = pagesPayload?.body || pagesPayload || []
    if (!Array.isArray(pages) || !pages.length) throw new Error('Pixiv returned no artwork pages.')
    const isUgoira = Number(meta.illustType) === 2

    const tags = []
    const tagCategories = {}
    const tagDisplayNames = {}
    for (const entry of meta?.tags?.tags || []) {
      const tag = translatedPixivTag(entry)
      if (!tag || tags.includes(tag)) continue
      tags.push(tag)
      tagCategories[tag] = 'general'
      const display = String(entry?.translation?.en || entry?.tag || '').trim()
      if (display) tagDisplayNames[tag] = display
    }

    const artworkTag = `pixiv_${artworkId}`
    tags.push(artworkTag)
    tagCategories[artworkTag] = 'meta'

    const userId = /^\d+$/.test(String(meta.userId || '')) ? String(meta.userId) : ''
    const artistName = String(meta.userName || '').trim()
    const artistTag = normalizeTag(artistName)
    if (artistTag) {
      if (!tags.includes(artistTag)) tags.push(artistTag)
      tagCategories[artistTag] = 'artist'
      tagDisplayNames[artistTag] = artistName
    }
    if (userId) {
      const userTag = `pixiv_user_${userId}`
      tags.push(userTag)
      tagCategories[userTag] = 'artist'
      if (artistName) tagDisplayNames[userTag] = `${artistName} (Pixiv)`
    }
    if (pages.length > 1) {
      tags.push('multiple_images')
      tagCategories.multiple_images = 'meta'
    }
    if (isUgoira) {
      if (!tags.includes('ugoira')) tags.push('ugoira')
      tagCategories.ugoira = 'meta'
    }

    const canonicalUrl = `https://www.pixiv.net/en/artworks/${artworkId}`
    let media
    if (isUgoira) {
      if (ugoiraPayload?.error) throw new Error(ugoiraPayload.message || 'Pixiv did not return the animation data.')
      const ugoira = ugoiraPayload?.body || ugoiraPayload || {}
      const original = String(ugoira.originalSrc || ugoira.src || '').trim()
      const frames = Array.isArray(ugoira.frames) ? ugoira.frames.map((frame) => ({
        file: String(frame?.file || ''),
        delay: Number(frame?.delay),
      })) : []
      if (!/^https:\/\//i.test(original) || !frames.length) {
        throw new Error('Pixiv returned incomplete animation data.')
      }
      const page = pages[0] || {}
      const pageTag = `pixiv_${artworkId}_p1`
      media = [{
        type: 'ugoira',
        url: original,
        referer: 'https://www.pixiv.net/',
        index: 0,
        width: page.width || null,
        height: page.height || null,
        frameCount: frames.length,
        frames,
        source: canonicalUrl,
        tags: [...tags, pageTag],
        tagCategories: { ...tagCategories, [pageTag]: 'meta' },
        tagDisplayNames: { ...tagDisplayNames },
        safety: pixivSafety(meta),
      }]
    } else media = pages.map((page, index) => {
      const original = String(page?.urls?.original || '').trim()
      if (!/^https:\/\//i.test(original)) throw new Error(`Pixiv page ${index + 1} has no original image URL.`)
      const pageTag = `pixiv_${artworkId}_p${index + 1}`
      return {
        url: original,
        referer: 'https://www.pixiv.net/',
        index,
        width: page.width || null,
        height: page.height || null,
        source: canonicalUrl,
        tags: [...tags, pageTag],
        tagCategories: { ...tagCategories, [pageTag]: 'meta' },
        tagDisplayNames: { ...tagDisplayNames },
        safety: pixivSafety(meta),
      }
    })

    return {
      kind: 'pixiv',
      artworkId,
      title: String(meta.illustTitle || meta.title || `Pixiv ${artworkId}`),
      artist: String(meta.userName || ''),
      canonicalUrl,
      groupTag: artworkTag,
      isUgoira,
      media,
    }
  }

  const DANBOORU_TAG_FIELDS = [
    ['tag_string_artist', 'artist'],
    ['tag_string_copyright', 'copyright'],
    ['tag_string_character', 'character'],
    ['tag_string_general', 'general'],
    ['tag_string_meta', 'meta'],
  ]
  const DANBOORU_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'zip'])

  // NekoBooru flattens tag names to letters, digits and _ : . - only, so a
  // Danbooru tag like "seitokai_ni_mo_ana_wa_aru!" keeps its spelling only as
  // the display name - which is also what the tag menu's booru searches use.
  function booruDisplayNames(tags) {
    const names = {}
    for (const tag of tags) {
      // All-symbol tags ("?", "@_@") flatten to nothing and are dropped anyway.
      if (/[^\p{L}\p{N}_:.-]/u.test(tag) && /[\p{L}\p{N}]/u.test(tag)) names[tag] = tag.replace(/_/g, ' ')
    }
    return names
  }

  // A Danbooru post's /posts/<id>.json -> an import job for its original file.
  // Ugoira originals are zips of frames, so those take Danbooru's own webm.
  function danbooruImportJob(payload, pageUrl) {
    const postId = danbooruPostId(pageUrl)
    if (!postId) throw new Error('Open a Danbooru post first.')
    const post = payload && typeof payload === 'object' ? payload : {}
    if (String(post.id || '') !== postId) throw new Error('Danbooru did not return this post.')
    const ext = String(post.file_ext || '').toLowerCase()
    const fileUrl = String((ext === 'zip' ? post.large_file_url : post.file_url) || '').trim()
    if (!/^https:\/\//i.test(fileUrl)) {
      throw new Error('Danbooru hid the original file. Log in to Danbooru (some posts need a Gold account) and try again.')
    }

    const tags = []
    const tagCategories = {}
    for (const [field, category] of DANBOORU_TAG_FIELDS) {
      for (const raw of String(post[field] || '').split(/\s+/)) {
        const tag = normalizeTag(raw)
        if (!tag || tags.includes(tag)) continue
        tags.push(tag)
        tagCategories[tag] = category
      }
    }
    const idTag = `danbooru_${postId}`
    if (!tags.includes(idTag)) tags.push(idTag)
    tagCategories[idTag] = 'meta'

    const canonicalUrl = `https://danbooru.donmai.us/posts/${postId}`
    return {
      kind: 'danbooru',
      postId,
      title: `Danbooru #${postId}`,
      canonicalUrl,
      groupTag: idTag,
      media: [{
        type: DANBOORU_VIDEO_EXTENSIONS.has(ext) ? 'video' : 'image',
        url: fileUrl,
        referer: 'https://danbooru.donmai.us/',
        index: 0,
        width: importDimension(post.image_width),
        height: importDimension(post.image_height),
        source: canonicalUrl,
        tags,
        tagCategories,
        tagDisplayNames: booruDisplayNames(tags),
        safety: booruImportSafety(post.rating),
      }],
    }
  }

  function sanitizeDanbooruImportJob(raw, senderUrl) {
    const senderId = danbooruPostId(senderUrl)
    const job = raw && typeof raw === 'object' ? raw : {}
    if (!senderId || String(job.postId) !== senderId) throw new Error('Danbooru post ID mismatch.')
    const item = Array.isArray(job.media) ? job.media[0] : null
    const mediaUrl = new URL(item?.url || '')
    if (
      mediaUrl.protocol !== 'https:' ||
      !isDanbooruHost(mediaUrl.hostname) ||
      !/^\/+(original|sample)\//i.test(mediaUrl.pathname)
    ) {
      throw new Error('Danbooru did not provide a trusted original URL.')
    }

    const idTag = `danbooru_${senderId}`
    const { tags, tagCategories } = sanitizedImportTags(item, idTag)
    const displayNames = booruDisplayNames(tags)
    const canonicalUrl = `https://danbooru.donmai.us/posts/${senderId}`
    return {
      kind: 'danbooru',
      postId: senderId,
      title: `Danbooru #${senderId}`,
      canonicalUrl,
      groupTag: idTag,
      media: [{
        type: item?.type === 'video' ? 'video' : 'image',
        url: mediaUrl.href,
        referer: 'https://danbooru.donmai.us/',
        index: 0,
        width: importDimension(item?.width),
        height: importDimension(item?.height),
        source: canonicalUrl,
        tags,
        tagCategories,
        tagDisplayNames: displayNames,
        safety: ['safe', 'sketchy', 'unsafe'].includes(item?.safety) ? item.safety : 'safe',
      }],
    }
  }

  // A Danbooru search/listing page (/posts?tags=...&page=..., or the front
  // page, which lists posts too) -> its query, or null for any other page.
  function danbooruSearchPage(raw) {
    try {
      const url = new URL(raw)
      if (!isDanbooruHost(url.hostname)) return null
      if (url.pathname !== '/' && !/^\/posts\/?$/.test(url.pathname)) return null
      const tags = String(url.searchParams.get('tags') || '').trim().replace(/\s+/g, ' ').slice(0, 500)
      const page = String(url.searchParams.get('page') || '1').slice(0, 20)
      return { tags, page }
    } catch {
      return null
    }
  }

  // The plain tags of a Danbooru query, as a NekoBooru search for the batch:
  // metatags (order:score, rating:g), negations and OR terms have no
  // NekoBooru meaning here, so they are left out.
  function danbooruSearchGroupQuery(tags) {
    return String(tags || '')
      .split(/\s+/)
      .filter((tag) => tag && !tag.includes(':') && !/^[-~]/.test(tag) && !tag.includes('*'))
      .map((tag) => normalizeTag(tag))
      .filter(Boolean)
      .slice(0, 6)
      .join(' ')
  }

  const DANBOORU_SEARCH_MAX_POSTS = 200

  // Every post shown on a Danbooru search page -> one job of original files,
  // in page order. Posts whose original Danbooru withholds (Gold-only while
  // logged out, deleted, banned) are listed as unavailable rather than failing
  // the batch.
  function danbooruSearchImportJob(posts, ids, pageUrl) {
    const search = danbooruSearchPage(pageUrl)
    if (!search) throw new Error('Open a Danbooru search page first.')
    const byId = new Map((Array.isArray(posts) ? posts : []).map((post) => [String(post?.id || ''), post]))
    const media = []
    const unavailable = []
    for (const id of (Array.isArray(ids) ? ids : []).map(String).filter((id) => /^\d+$/.test(id)).slice(0, DANBOORU_SEARCH_MAX_POSTS)) {
      const post = byId.get(id)
      try {
        if (!post) throw new Error('Danbooru did not return this post.')
        const item = danbooruImportJob(post, `https://danbooru.donmai.us/posts/${id}`).media[0]
        media.push({ ...item, postId: id, label: `Danbooru #${id}`, index: media.length })
      } catch (error) {
        unavailable.push({ postId: id, reason: error?.message || String(error) })
      }
    }
    const pageLabel = search.page && search.page !== '1' ? ` · page ${search.page}` : ''
    return {
      kind: 'danbooru_search',
      postId: `${search.tags}|${search.page}`,
      title: `Danbooru: ${search.tags || 'latest posts'}${pageLabel}`,
      canonicalUrl: `https://danbooru.donmai.us/posts?${new URLSearchParams({ tags: search.tags, page: search.page })}`,
      groupTag: danbooruSearchGroupQuery(search.tags),
      unavailable,
      media,
    }
  }

  function sanitizeDanbooruSearchImportJob(raw, senderUrl) {
    const search = danbooruSearchPage(senderUrl)
    const job = raw && typeof raw === 'object' ? raw : {}
    if (!search || String(job.postId) !== `${search.tags}|${search.page}`) {
      throw new Error('Danbooru search page mismatch.')
    }
    const media = []
    for (const item of (Array.isArray(job.media) ? job.media : []).slice(0, DANBOORU_SEARCH_MAX_POSTS)) {
      const postId = String(item?.postId || '')
      if (!/^\d+$/.test(postId) || media.some((entry) => entry.postId === postId)) continue
      const clean = sanitizeDanbooruImportJob({ postId, media: [item] }, `https://danbooru.donmai.us/posts/${postId}`).media[0]
      media.push({ ...clean, postId, label: `Danbooru #${postId}`, index: media.length })
    }
    if (!media.length) throw new Error('None of the posts on this page has an original file Danbooru will hand out.')
    const unavailable = (Array.isArray(job.unavailable) ? job.unavailable : [])
      .slice(0, DANBOORU_SEARCH_MAX_POSTS)
      .filter((entry) => /^\d+$/.test(String(entry?.postId || '')))
      .map((entry) => ({ postId: String(entry.postId), reason: String(entry.reason || '').slice(0, 200) }))
    const pageLabel = search.page && search.page !== '1' ? ` · page ${search.page}` : ''
    return {
      kind: 'danbooru_search',
      postId: `${search.tags}|${search.page}`,
      title: `Danbooru: ${search.tags || 'latest posts'}${pageLabel}`,
      canonicalUrl: `https://danbooru.donmai.us/posts?${new URLSearchParams({ tags: search.tags, page: search.page })}`,
      groupTag: danbooruSearchGroupQuery(search.tags),
      unavailable,
      media,
    }
  }

  // A Gelbooru search/listing page (index.php?page=post&s=list&tags=...&pid=N)
  // -> its query and post offset (the site's pid counts posts, not pages).
  function gelbooruSearchPage(raw) {
    try {
      const url = new URL(raw)
      if (!isGelbooruHost(url.hostname)) return null
      if (url.searchParams.get('page') !== 'post' || url.searchParams.get('s') !== 'list') return null
      const tags = String(url.searchParams.get('tags') || '').trim().replace(/\s+/g, ' ').slice(0, 500)
      const offset = Number.parseInt(url.searchParams.get('pid') || '0', 10)
      return { tags: tags === 'all' ? '' : tags, offset: Number.isInteger(offset) && offset > 0 ? offset : 0 }
    } catch {
      return null
    }
  }

  const GELBOORU_SEARCH_MAX_POSTS = 100

  // What crosses from the Gelbooru content script: just the page and the post
  // IDs it showed. The backend, holding the API key, resolves the files.
  function gelbooruSearchImportJob(ids, pageUrl) {
    const search = gelbooruSearchPage(pageUrl)
    if (!search) throw new Error('Open a Gelbooru search page first.')
    const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => /^\d+$/.test(id)))].slice(0, GELBOORU_SEARCH_MAX_POSTS)
    if (!cleanIds.length) throw new Error('No posts on this page to import.')
    const pageNumber = Math.floor(search.offset / 42) + 1
    const pageLabel = pageNumber > 1 ? ` · page ${pageNumber}` : ''
    return {
      kind: 'gelbooru_search',
      postId: `${search.tags}|${search.offset}`,
      tags: search.tags,
      offset: search.offset,
      ids: cleanIds,
      title: `Gelbooru: ${search.tags || 'latest posts'}${pageLabel}`,
      groupTag: danbooruSearchGroupQuery(search.tags),
    }
  }

  function sanitizeGelbooruSearchImportJob(raw, senderUrl) {
    const search = gelbooruSearchPage(senderUrl)
    const job = raw && typeof raw === 'object' ? raw : {}
    if (!search || String(job.postId) !== `${search.tags}|${search.offset}`) {
      throw new Error('Gelbooru search page mismatch.')
    }
    return gelbooruSearchImportJob(job.ids, senderUrl)
  }

  // The backend's answer for a Gelbooru search page -> the batch's media list.
  function gelbooruSearchMedia(data) {
    return (Array.isArray(data?.posts) ? data.posts : []).map((post, index) => {
      const postId = String(post.postId)
      const tags = Array.isArray(post.tags) ? post.tags : []
      return {
        type: /\.(mp4|webm)(?:$|[?#])/i.test(String(post.fileUrl || '')) ? 'video' : 'image',
        url: post.fileUrl,
        referer: post.referer || 'https://gelbooru.com/',
        index,
        width: importDimension(post.width),
        height: importDimension(post.height),
        source: post.postUrl,
        tags,
        tagCategories: post.tagCategories || {},
        tagDisplayNames: booruDisplayNames(tags),
        safety: ['safe', 'sketchy', 'unsafe'].includes(post.safety) ? post.safety : 'safe',
        postId,
        idTag: `gelbooru_${postId}`,
        label: `Gelbooru #${postId}`,
      }
    })
  }

  // "Posts | Artist" over a Danbooru search: the import goes right of the last
  // of those links (Artist, or a wiki link, else Posts) in the same item.
  function selectDanbooruSearchAnchor(doc) {
    const after = doc?.querySelector?.('#post-sections #show-excerpt-link')
      || doc?.querySelector?.('#post-sections #show-posts-link')
    return after?.parentElement ? { list: after.parentElement, after } : null
  }

  // The "Comments | Recommended" tabs under a Danbooru post (#post-sections):
  // the import sits right of Recommended, as another item of that menu.
  function selectDanbooruSectionsAnchor(doc) {
    const links = Array.from(doc?.querySelectorAll?.('#post-sections a') || [])
    const recommended = links.find((link) => (
      /#recommended$/i.test(link.getAttribute?.('href') || '') ||
      String(link.textContent || '').trim().toLowerCase() === 'recommended'
    ))
    const item = recommended?.closest?.('li')
    return item?.parentElement ? { list: item.parentElement, after: item } : null
  }

  // Danbooru's sidebar "Options" list: the import goes after Favorite /
  // Unfavorite (only shown when logged in), else after Download, else last.
  function selectDanbooruOptionsAnchor(doc) {
    const list = doc?.querySelector?.('#post-options ul')
    if (!list) return null
    const after = doc.querySelector('#post-option-remove-from-favorites')
      || doc.querySelector('#post-option-add-to-favorites')
      || doc.querySelector('#post-option-download')
    return { list, after: after && after.parentElement === list ? after : null }
  }

  function siteImportPostBody(job, item, contentToken) {
    const pixiv = job?.kind === 'pixiv'
    return {
      contentToken,
      safety: item?.safety || 'safe',
      tags: item?.tags || [],
      tagCategories: item?.tagCategories || {},
      tagDisplayNames: item?.tagDisplayNames || {},
      source: item?.source || job?.canonicalUrl,
      autoTag: pixiv,
      autoTagProfile: pixiv ? 'pixiv_import' : 'gelbooru_import',
    }
  }

  function selectGelbooruActionFavorite(controls) {
    const candidates = Array.from(controls || [])
    const inActionRow = candidates.find((node) => {
      const rowText = String(node?.parentElement?.textContent || '')
      return /\bedit\b/i.test(rowText) && /leave a comment/i.test(rowText)
    })
    return inActionRow || candidates.at(-1) || null
  }

  function selectPixivShareControl(controls) {
    const allControls = Array.from(controls || [])
    const labelFor = (node) => {
      const datasetValues = node?.dataset ? Object.values(node.dataset) : []
      const nestedLabel = node?.querySelector?.('[aria-label], title')
      return [
        node?.textContent,
        node?.title,
        node?.getAttribute?.('aria-label'),
        node?.getAttribute?.('data-gtm-action'),
        node?.getAttribute?.('data-click-label'),
        nestedLabel?.getAttribute?.('aria-label'),
        nestedLabel?.textContent,
        ...datasetValues,
      ].map((part) => String(part || '')).join(' ')
    }
    const visibleRect = (node) => {
      const rect = node?.getBoundingClientRect?.()
      if (!rect || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0) return null
      const view = node?.ownerDocument?.defaultView
      const style = view?.getComputedStyle?.(node)
      if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return null
      if (Number.isFinite(view?.innerWidth) && rect.left >= view.innerWidth) return null
      if (Number.isFinite(view?.innerHeight) && rect.top >= view.innerHeight) return null
      return rect
    }
    // Some Pixiv artwork layouts put role=button on a wrapper around the real
    // controls. Keep the innermost controls so a labelled toolbar wrapper does
    // not get mistaken for the Share button itself.
    const innerControls = allControls.filter((node, index, entries) => !entries.some((other, otherIndex) => (
      otherIndex !== index && node?.contains?.(other)
    )))
    const candidates = innerControls.filter((node) => (
      /(^|[^a-z])(share|シェア|共有)([^a-z]|$)/i.test(labelFor(node))
    ))
    const visible = candidates.find((node) => {
      return visibleRect(node)
    })
    if (visible) return visible

    // Newer/icon-only toolbars may expose only the final menu's accessible
    // label. In that layout Share is the visible control immediately before it.
    const more = innerControls.find((node) => (
      /(^|[^a-z])(more|menu|その他|メニュー)([^a-z]|$)/i.test(labelFor(node)) && visibleRect(node)
    ))
    const moreRect = visibleRect(more)
    if (moreRect) {
      const moreCenter = moreRect.top + (moreRect.height / 2)
      const tolerance = Math.max(14, moreRect.height * 0.75)
      const rowBeforeMore = innerControls
        .map((node) => ({ node, rect: visibleRect(node) }))
        .filter(({ rect }) => (
          rect && rect.left <= moreRect.left &&
          Math.abs((rect.top + (rect.height / 2)) - moreCenter) <= tolerance
        ))
        .sort((first, second) => first.rect.left - second.rect.left)
      if (rowBeforeMore.length >= 2) return rowBeforeMore.at(-2).node
    }

    // Pixiv sometimes renders this row as unlabeled icon buttons. Locate the
    // visible Like or Bookmark control, then choose the control immediately
    // left of the rightmost (three-dot) control on the same horizontal line.
    const actionAnchor = innerControls.find((node) => (
      /(^|[^a-z])(likes?|liked|bookmarks?|いいね|ブックマーク|收藏|북마크)([^a-z]|$)/i.test(labelFor(node)) && visibleRect(node)
    ))
    const anchorRect = visibleRect(actionAnchor)
    if (anchorRect) {
      const anchorCenter = anchorRect.top + (anchorRect.height / 2)
      const tolerance = Math.max(14, anchorRect.height * 0.75)
      const row = innerControls
        .map((node) => ({ node, rect: visibleRect(node) }))
        .filter(({ rect }) => (
          rect && rect.left >= anchorRect.left - 4 &&
          Math.abs((rect.top + (rect.height / 2)) - anchorCenter) <= tolerance
        ))
        .sort((first, second) => first.rect.left - second.rect.left)
      const moreIndex = row.findIndex(({ node }) => (
        /(^|[^a-z])(more|menu|その他|メニュー)([^a-z]|$)/i.test(labelFor(node))
      ))
      if (moreIndex > 0) return row[moreIndex - 1].node
      if (row.length >= 3) return row.at(-2).node
    }
    return null
  }

  // Everything that might name an icon-only control: its text, title and aria
  // label, its data attributes, and the class/sprite/alt of the icon inside.
  function iconControlLabel(node) {
    const icon = node?.querySelector?.('svg, img, use')
    const sprite = node?.querySelector?.('use')
    return [
      node?.textContent,
      node?.title,
      node?.getAttribute?.('aria-label'),
      node?.getAttribute?.('class'),
      ...(node?.dataset ? Object.values(node.dataset) : []),
      node?.querySelector?.('[aria-label]')?.getAttribute?.('aria-label'),
      node?.querySelector?.('title')?.textContent,
      icon?.getAttribute?.('class'),
      icon?.getAttribute?.('alt'),
      icon?.getAttribute?.('src'),
      sprite?.getAttribute?.('href') || sprite?.getAttribute?.('xlink:href'),
    ].map((part) => String(part || '')).join(' ')
  }

  // The red flag (report) control in the share / reaction / flag row under a
  // Sankaku post. Prefers a control that names itself flag or report; without
  // one, falls back to the last icon control in the Share control's row.
  function selectSankakuFlagControl(controls) {
    const all = Array.from(controls || []).filter((node) => node?.querySelector?.('svg, img'))
    const inner = all.filter((node, index) => !all.some((other, otherIndex) => (
      otherIndex !== index && node?.contains?.(other)
    )))
    const flag = inner.find((node) => /(^|[^a-z])(flag|report)/i.test(iconControlLabel(node)))
    if (flag) return flag
    const share = inner.find((node) => /(^|[^a-z])share([^a-z]|$)/i.test(iconControlLabel(node)))
    // Each icon may sit in its own wrapper: climb a few levels to the element
    // holding the whole row, never far enough to take in the rest of the page.
    let row = share?.parentElement
    for (let depth = 0; row && depth < 4; depth += 1, row = row.parentElement) {
      const siblings = inner.filter((node) => node !== share && row.contains(node))
      if (siblings.length >= 2) return siblings.at(-1)
    }
    return null
  }

  // "Downloading original… 12.3 / 36.0 MB (34%) · 180 KB/s · 70s". The rate
  // shows a slow source (Sankaku throttles video) for what it is.
  function downloadProgressText(progress, elapsedMs) {
    const received = Math.max(0, Number(progress?.received) || 0)
    const total = Math.max(0, Number(progress?.total) || 0)
    const seconds = Math.max(0, Math.round((Number(elapsedMs) || 0) / 1000))
    const megabytes = (bytes) => (bytes / 1048576).toFixed(1)
    const parts = [total
      ? `${megabytes(received)} / ${megabytes(total)} MB (${Math.min(100, Math.floor((received * 100) / total))}%)`
      : `${megabytes(received)} MB`]
    if (seconds > 0 && received > 0) parts.push(`${Math.round(received / 1024 / seconds)} KB/s`)
    parts.push(`${seconds}s`)
    return `Downloading original… ${parts.join(' · ')}`
  }

  function selectedSiteImportMedia(media, selectedIndexes) {
    const selected = new Set(Array.from(selectedIndexes || []).map((value) => Number(value)))
    return Array.from(media || []).filter((item, i) => selected.has(Number.isInteger(item?.index) ? item.index : i))
  }

  const api = {
    normalizeTag,
    pixivArtworkId,
    isGelbooruHost,
    gelbooruPostId,
    isDanbooruHost,
    danbooruPostId,
    danbooruImportJob,
    sanitizeDanbooruImportJob,
    selectDanbooruOptionsAnchor,
    selectDanbooruSectionsAnchor,
    danbooruSearchPage,
    danbooruSearchGroupQuery,
    danbooruSearchImportJob,
    sanitizeDanbooruSearchImportJob,
    selectDanbooruSearchAnchor,
    gelbooruSearchPage,
    gelbooruSearchImportJob,
    sanitizeGelbooruSearchImportJob,
    gelbooruSearchMedia,
    safebooruPostId,
    safebooruImportJob,
    sanitizeSafebooruImportJob,
    isSankakuHost,
    sankakuPostId,
    sankakuLegacyPostUrl,
    sankakuOriginalFromPage,
    sankakuHeadingCategory,
    sankakuPageSafety,
    sankakuPageImportJob,
    sankakuSafety,
    sankakuAccessToken,
    sankakuImportJob,
    sanitizeSankakuImportJob,
    pixivImportJob,
    pixivSafety,
    selectGelbooruActionFavorite,
    selectPixivShareControl,
    selectSankakuFlagControl,
    selectedSiteImportMedia,
    downloadProgressText,
    siteImportPostBody,
  }
  root.NekoBooruSiteImport = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
