;(function installSiteImportSankaku(root) {
  // Sankaku imports: its hosts and post IDs, the API and logged-in-page import
  // jobs, and sanitizing them in the background. Part of
  // globalThis.NekoBooruSiteImport (see site-import-core.js); loads after
  // site-import-shared.js.
  const { normalizeTag, sanitizedImportTags, importDimension } =
    root.NekoBooruSiteImportShared || require('./site-import-shared.js')

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

  const api = {
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
  }
  root.NekoBooruSiteImportSankaku = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
