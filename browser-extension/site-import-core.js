;(function installSiteImportCore(root) {
  // site-import-core.js assembles globalThis.NekoBooruSiteImport from its
  // parts, which load before it wherever it runs (manifest content scripts,
  // background.js importScripts, site-import.html) and come in through
  // require() under Node tests: shared host/tag helpers, Sankaku jobs, and
  // the page-control selectors.
  const part = (name, file) => root[name] || require(file)
  const {
    normalizeTag, pixivArtworkId, isGelbooruHost, gelbooruPostId, safebooruPostId, isDanbooruHost, danbooruPostId,
    IMPORT_CATEGORIES, sanitizedImportTags, importDimension, booruImportSafety, booruDisplayNames,
  } = part('NekoBooruSiteImportShared', './site-import-shared.js')
  const {
    isSankakuHost, sankakuPostId, sankakuLegacyPostUrl, sankakuOriginalFromPage, sankakuHeadingCategory,
    sankakuPageSafety, sankakuPageImportJob, sankakuSafety, sankakuAccessToken, sankakuImportJob, sanitizeSankakuImportJob,
  } = part('NekoBooruSiteImportSankaku', './site-import-sankaku.js')
  const {
    selectDanbooruOptionsAnchor, selectDanbooruSectionsAnchor, selectDanbooruSearchAnchor, selectGelbooruActionFavorite,
    selectPixivShareControl, selectSankakuFlagControl, selectedSiteImportMedia, downloadProgressText, siteImportPostBody,
  } = part('NekoBooruSiteImportControls', './site-import-controls.js')

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
