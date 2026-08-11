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
      return rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 ? rect : null
    }
    const candidates = allControls.filter((node) => (
      /(^|[^a-z])(share|シェア|共有)([^a-z]|$)/i.test(labelFor(node))
    ))
    const visible = candidates.find((node) => {
      return visibleRect(node)
    })
    if (visible) return visible

    // Pixiv sometimes renders this row as unlabeled icon buttons. Locate the
    // visible Like control, then choose the control immediately left of the
    // rightmost (three-dot) control on the same horizontal line.
    const like = allControls.find((node) => (
      /(^|[^a-z])(like|いいね)([^a-z]|$)/i.test(labelFor(node)) && visibleRect(node)
    ))
    const likeRect = visibleRect(like)
    if (likeRect) {
      const likeCenter = likeRect.top + (likeRect.height / 2)
      const tolerance = Math.max(14, likeRect.height * 0.75)
      const row = allControls
        .map((node) => ({ node, rect: visibleRect(node) }))
        .filter(({ rect }) => (
          rect && rect.left >= likeRect.left - 4 &&
          Math.abs((rect.top + (rect.height / 2)) - likeCenter) <= tolerance
        ))
        .filter(({ node }, index, entries) => !entries.some(({ node: other }, otherIndex) => (
          otherIndex !== index && other?.contains?.(node)
        )))
        .sort((first, second) => first.rect.left - second.rect.left)
      if (row.length >= 3) return row.at(-2).node
    }
    return candidates[0] || null
  }

  function selectedSiteImportMedia(media, selectedIndexes) {
    const selected = new Set(Array.from(selectedIndexes || []).map((value) => Number(value)))
    return Array.from(media || []).filter((item, arrayIndex) => {
      const mediaIndex = Number.isInteger(item?.index) ? item.index : arrayIndex
      return selected.has(mediaIndex)
    })
  }

  const api = {
    normalizeTag,
    pixivArtworkId,
    gelbooruPostId,
    pixivImportJob,
    pixivSafety,
    selectGelbooruActionFavorite,
    selectPixivShareControl,
    selectedSiteImportMedia,
    siteImportPostBody,
  }
  root.NekoBooruSiteImport = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
