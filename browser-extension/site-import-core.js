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

  function gelbooruPostId(raw) {
    try {
      const url = new URL(raw)
      const host = url.hostname.replace(/^www\./, '').toLowerCase()
      if (host !== 'gelbooru.com' || url.searchParams.get('page') !== 'post') return ''
      const id = url.searchParams.get('id') || ''
      return /^\d+$/.test(id) ? id : ''
    } catch {
      return ''
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

  function pixivImportJob(metaPayload, pagesPayload, pageUrl) {
    const artworkId = pixivArtworkId(pageUrl)
    if (!artworkId) throw new Error('This is not a Pixiv artwork page.')
    if (metaPayload?.error || pagesPayload?.error) {
      throw new Error(metaPayload?.message || pagesPayload?.message || 'Pixiv did not return this artwork.')
    }
    const meta = metaPayload?.body || metaPayload || {}
    const pages = pagesPayload?.body || pagesPayload || []
    if (!Array.isArray(pages) || !pages.length) throw new Error('Pixiv returned no artwork pages.')

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

    const canonicalUrl = `https://www.pixiv.net/en/artworks/${artworkId}`
    const media = pages.map((page, index) => {
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
      media,
    }
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

  const api = {
    normalizeTag,
    pixivArtworkId,
    gelbooruPostId,
    pixivImportJob,
    pixivSafety,
    siteImportPostBody,
  }
  root.NekoBooruSiteImport = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
