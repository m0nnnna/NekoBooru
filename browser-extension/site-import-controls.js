;(function installSiteImportControls(root) {
  // Where the import buttons go on each site's page (Danbooru, Gelbooru,
  // Pixiv, Sankaku), plus the import page's post body, progress text and
  // media selection. Part of globalThis.NekoBooruSiteImport (see
  // site-import-core.js). The post body and progress text come from
  // booru-import-rules.js, which loads first.
  const rules = root.NekoBooruImportRules || require('./booru-import-rules.js')

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

  // The post body itself is booru-import-rules.js's; the extension picks the
  // source fallback and runs AI tagging on Pixiv imports only.
  function siteImportPostBody(job, item, contentToken) {
    const pixiv = job?.kind === 'pixiv'
    return rules.importPostBody({
      contentToken,
      safety: item?.safety,
      tags: item?.tags,
      tagCategories: item?.tagCategories,
      tagDisplayNames: item?.tagDisplayNames,
      source: item?.source || job?.canonicalUrl,
      autoTag: pixiv,
      autoTagProfile: pixiv ? 'pixiv_import' : 'gelbooru_import',
    })
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

  function selectedSiteImportMedia(media, selectedIndexes) {
    const selected = new Set(Array.from(selectedIndexes || []).map((value) => Number(value)))
    return Array.from(media || []).filter((item, i) => selected.has(Number.isInteger(item?.index) ? item.index : i))
  }

  const api = {
    selectDanbooruOptionsAnchor,
    selectDanbooruSectionsAnchor,
    selectDanbooruSearchAnchor,
    selectGelbooruActionFavorite,
    selectPixivShareControl,
    selectSankakuFlagControl,
    selectedSiteImportMedia,
    downloadProgressText: rules.downloadProgressText,
    siteImportPostBody,
  }
  root.NekoBooruSiteImportControls = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
