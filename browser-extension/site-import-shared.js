;(function installSiteImportShared(root) {
  // Site-import helpers every importer shares: tag normalizing, the post-ID
  // and host checks, and the sanitizing of what crosses from a content
  // script. Part of globalThis.NekoBooruSiteImport (see site-import-core.js);
  // load before site-import-sankaku.js and site-import-core.js.

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

  function booruImportSafety(raw) {
    const rating = String(raw || '').trim().toLowerCase()
    if (rating === 'e' || rating === 'explicit') return 'unsafe'
    return ['q', 'questionable', 's', 'sensitive'].includes(rating) ? 'sketchy' : 'safe'
  }

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

  const api = {
    normalizeTag,
    pixivArtworkId,
    isGelbooruHost,
    gelbooruPostId,
    safebooruPostId,
    isDanbooruHost,
    danbooruPostId,
    IMPORT_CATEGORIES,
    sanitizedImportTags,
    importDimension,
    booruImportSafety,
    booruDisplayNames,
  }
  root.NekoBooruSiteImportShared = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
