;(function installSiteImportButtons() {
  if (window.top !== window || !globalThis.NekoBooruSiteImport) return

  const core = globalThis.NekoBooruSiteImport
  const PIXIV_HOST = location.hostname === 'pixiv.net' || location.hostname.endsWith('.pixiv.net')
  const GELBOORU_HOST = core.isGelbooruHost(location.hostname)
  const SAFEBOORU_HOST = location.hostname.replace(/^www\./, '') === 'safebooru.org'
  const DANBOORU_HOST = core.isDanbooruHost(location.hostname)
  const BOORU_KIND = GELBOORU_HOST ? 'gelbooru' : (SAFEBOORU_HOST ? 'safebooru' : (DANBOORU_HOST ? 'danbooru' : ''))
  const BOORU_LABEL = { gelbooru: 'Gelbooru', safebooru: 'Safebooru', danbooru: 'Danbooru' }[BOORU_KIND] || ''
  const SANKAKU_HOST = core.isSankakuHost(location.hostname)
  if (!PIXIV_HOST && !BOORU_KIND && !SANKAKU_HOST) return

  function installStyle() {
    if (document.getElementById('nekobooru-site-import-style')) return
    const style = document.createElement('style')
    style.id = 'nekobooru-site-import-style'
    style.textContent = `
      .nekobooru-site-import-inline { cursor: pointer; font: inherit; white-space: nowrap; }
      [data-nekobooru-site-import][data-nekobooru-busy="true"] { cursor: wait !important; opacity: .65; }    `
    document.documentElement.appendChild(style)
  }

  function createInlineLink(label, kind) {
    const link = document.createElement('a')
    link.href = '#'
    link.className = 'nekobooru-site-import-inline'
    link.dataset.nekobooruSiteImport = kind
    link.title = `Import ${BOORU_LABEL}'s original-resolution file and tags to NekoBooru`
    link.setAttribute('aria-label', link.title)
    const text = document.createElement('span')
    text.dataset.nekobooruImportLabel = 'true'
    text.textContent = label
    link.appendChild(text)
    link.addEventListener('click', handleImportClick)
    return link
  }

  function createPixivIconButton(share) {
    const button = share.cloneNode(true)
    button.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'))
    button.removeAttribute('id')
    button.removeAttribute('onclick')
    button.removeAttribute('aria-expanded')
    button.removeAttribute('aria-haspopup')
    button.removeAttribute('aria-controls')
    if (button.tagName === 'BUTTON') button.type = 'button'
    if (button.tagName === 'A') button.href = '#'
    button.dataset.nekobooruSiteImport = 'pixiv'
    button.dataset.nekobooruBusy = 'false'
    button.title = 'Import every original-resolution page to NekoBooru'
    button.setAttribute('aria-label', button.title)

    let icon = button.querySelector('svg')
    if (!icon) {
      icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      button.replaceChildren(icon)
    }
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '2')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = '<path d="M12 3v12"></path><path d="m7.5 10.5 4.5 4.5 4.5-4.5"></path><path d="M5 17.5v.7A2.8 2.8 0 0 0 7.8 21h8.4a2.8 2.8 0 0 0 2.8-2.8v-.7"></path>'
    button.addEventListener('click', handleImportClick)
    return button
  }

  async function pixivJob() {
    const artworkId = core.pixivArtworkId(location.href)
    if (!artworkId) throw new Error('Open a Pixiv artwork first.')
    const [metaResponse, pagesResponse] = await Promise.all([
      fetch(`/ajax/illust/${artworkId}?lang=en`, { credentials: 'include', cache: 'no-store' }),
      fetch(`/ajax/illust/${artworkId}/pages?lang=en`, { credentials: 'include', cache: 'no-store' }),
    ])
    if (!metaResponse.ok || !pagesResponse.ok) {
      throw new Error(`Pixiv metadata request failed (HTTP ${!metaResponse.ok ? metaResponse.status : pagesResponse.status}).`)
    }
    const metaPayload = await metaResponse.json()
    const pagesPayload = await pagesResponse.json()
    let ugoiraPayload = null
    if (Number(metaPayload?.body?.illustType) === 2) {
      const ugoiraResponse = await fetch(`/ajax/illust/${artworkId}/ugoira_meta?lang=en`, {
        credentials: 'include',
        cache: 'no-store',
      })
      if (!ugoiraResponse.ok) throw new Error(`Pixiv animation metadata failed (HTTP ${ugoiraResponse.status}).`)
      ugoiraPayload = await ugoiraResponse.json()
    }
    return core.pixivImportJob(metaPayload, pagesPayload, location.href, ugoiraPayload)
  }

  function booruOriginalFallback() {
    const direct = document.querySelector('a#high-res[href], a[download][href]')
    if (direct?.href) return direct.href
    const labelled = Array.from(document.querySelectorAll('a[href]')).find((anchor) => (
      /^(original image|view original|original|download original)$/i.test(anchor.textContent.trim())
    ))
    if (labelled?.href) return labelled.href
    const image = document.querySelector('img#image, #image-container img')
    return image?.closest('a[href]')?.href || image?.dataset?.original || image?.src || ''
  }

  function gelbooruJob() {
    const postId = core.gelbooruPostId(location.href)
    if (!postId) throw new Error('Open a Gelbooru post first.')
    return {
      kind: 'gelbooru',
      postId,
      pageUrl: `https://gelbooru.com/index.php?page=post&s=view&id=${postId}`,
      fallbackOriginalUrl: booruOriginalFallback(),
      title: `Gelbooru #${postId}`,
      groupTag: `gelbooru_${postId}`,
    }
  }

  async function safebooruJob() {
    const postId = core.safebooruPostId(location.href)
    if (!postId) throw new Error('Open a Safebooru post first.')
    let payload = null
    try {
      const response = await fetch(`/index.php?page=dapi&s=post&q=index&json=1&id=${encodeURIComponent(postId)}`, {
        credentials: 'include',
        cache: 'no-store',
      })
      if (response.ok) payload = await response.json()
    } catch {
      // The visible original link and tag sidebar remain a complete fallback.
    }
    const scraped = globalThis.NekoBooruBooruTags?.scrapeBooruTagsFromPage?.() || null
    return core.safebooruImportJob(payload, scraped, location.href, booruOriginalFallback())
  }

  // Danbooru's JSON API needs no key; fetched same-origin it carries the
  // reader's login, so Gold-only originals come through for those who have it.
  async function danbooruJob() {
    const postId = core.danbooruPostId(location.href)
    if (!postId) throw new Error('Open a Danbooru post first.')
    const response = await fetch(`/posts/${encodeURIComponent(postId)}.json`, {
      credentials: 'include',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Danbooru post lookup failed (HTTP ${response.status}).`)
    return core.danbooruImportJob(await response.json(), location.href)
  }

  function booruJob() {
    if (DANBOORU_HOST) return danbooruJob()
    return GELBOORU_HOST ? gelbooruJob() : safebooruJob()
  }

  // Both Sankaku front-ends keep the login's API token where their own script
  // can read it. Reusing it lets explicit and members-only posts import; it is
  // sent only to Sankaku's API and never leaves this page.
  function sankakuSessionToken() {
    const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('accessToken='))
    let fromCookie = ''
    try { fromCookie = cookie ? decodeURIComponent(cookie.slice('accessToken='.length)) : '' } catch { /* malformed */ }
    let stored = ''
    try { stored = localStorage.getItem('accessToken') || '' } catch { /* storage blocked */ }
    return core.sankakuAccessToken(fromCookie) || core.sankakuAccessToken(stored)
  }

  function fetchSankakuPost(postId, token) {
    const headers = { Accept: 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(`https://sankakuapi.com/posts/${encodeURIComponent(postId)}`, {
      headers,
      credentials: 'omit',
      cache: 'no-store',
    })
  }

  // Classic Sankaku Channel's Details list: "Original: <a>592x782 (... JPG)</a>".
  function sankakuPageOriginalLink() {
    const highres = document.querySelector('a#highres[href]')
    if (highres) return highres
    return Array.from(document.querySelectorAll('a[href]')).find((anchor) => (
      /original:\s*$/i.test(anchor.previousSibling?.textContent || '') ||
      /^original:?$/i.test(anchor.previousElementSibling?.textContent?.trim() || '')
    )) || null
  }

  function sankakuPageOriginalUrl() {
    return sankakuPageOriginalLink()?.href || ''
  }

  // A sidebar tag link searches for exactly that tag: ?tags=<one tag>.
  // Metatag links (rating:, user:, order:) are not post tags.
  function sankakuTagFromHref(raw) {
    try {
      const url = new URL(raw, location.href)
      if (!core.isSankakuHost(url.hostname)) return ''
      const tags = String(url.searchParams.get('tags') || '').trim()
      return tags && !/[\s:]/.test(tags) ? tags : ''
    } catch {
      return ''
    }
  }

  // The sidebar lists tags under headings (Character, Flora, Medium, Meta, ...).
  // Walk it in reading order: a short label right before a run of tag links
  // is that run's heading. Counts and the "?" wiki links are not labels.
  function sankakuPageTags() {
    const found = []
    let pending = ''
    let heading = ''
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.closest('[data-nekobooru-sankaku-slot], script, style, noscript, template, [hidden], [aria-hidden="true"]')) continue
      if (node.tagName === 'A') {
        const name = sankakuTagFromHref(node.getAttribute('href') || '')
        if (!name) continue
        if (pending) {
          heading = pending
          pending = ''
        }
        if (heading) found.push({ name, heading })
        continue
      }
      if (node.children.length || node.closest('a')) continue
      const text = String(node.textContent || '').trim()
      if (text && text.length <= 24 && !/^[\d.,]+\s*[kKmM]?$/.test(text) && !/^[?+\-•·»]$/.test(text)) pending = text
    }
    return found
  }

  function sankakuPageDetails() {
    const original = sankakuPageOriginalLink()
    const rating = String(document.body.textContent || '').match(/Rating:\s*(R18|R15|G|S|Q|E|Safe|General|Questionable|Sensitive|Explicit)\b/i)
    return {
      originalUrl: original?.href || '',
      dimensions: original?.textContent || '',
      rating: rating ? rating[1] : '',
      tags: sankakuPageTags(),
    }
  }

  async function sankakuJob() {
    const postId = core.sankakuPostId(location.href)
    if (!postId) throw new Error('Open a Sankaku post first.')
    const token = sankakuSessionToken()
    let response = await fetchSankakuPost(postId, token)
    // An expired session answers 401 even for posts anyone may see.
    if (token && response.status === 401) response = await fetchSankakuPost(postId, '')
    // Posts Sankaku shows only to logged-in users answer 404 to the API, but
    // the page in front of a logged-in viewer still carries all of it.
    if ([401, 403, 404].includes(response.status)) return core.sankakuPageImportJob(sankakuPageDetails(), location.href)
    if (!response.ok) throw new Error(`Sankaku metadata request failed (HTTP ${response.status}).`)
    return core.sankakuImportJob(await response.json(), location.href, sankakuPageOriginalUrl())
  }

  async function handleImportClick(event) {
    event.preventDefault()
    event.stopPropagation()
    const button = event.currentTarget
    if (button.dataset.nekobooruBusy === 'true') return
    const label = button.querySelector('[data-nekobooru-import-label]')
    const originalLabel = label?.textContent || ''
    const originalTitle = button.title
    const originalAriaLabel = button.getAttribute('aria-label') || ''
    button.dataset.nekobooruBusy = 'true'
    if ('disabled' in button) button.disabled = true
    if (label) label.textContent = 'Preparing…'
    button.title = 'Preparing NekoBooru import…'
    button.setAttribute('aria-label', button.title)
    try {
      const kind = button.dataset.nekobooruSiteImport
      const job = kind === 'pixiv' ? await pixivJob() : (kind === 'sankaku' ? await sankakuJob() : await booruJob())
      const response = await chrome.runtime.sendMessage({ type: 'nekobooru-open-site-import', job })
      if (!response?.ok) throw new Error(response?.error || 'The NekoBooru import window could not be opened.')
      if (label) label.textContent = response.alreadyOpen ? 'Already importing' : 'Import opened'
      button.title = response.alreadyOpen ? 'This post is already importing; its window was brought forward' : 'NekoBooru import opened'
    } catch (error) {
      if (label) label.textContent = 'Import failed'
      button.title = error?.message || String(error)
    } finally {
      setTimeout(() => {
        button.dataset.nekobooruBusy = 'false'
        if ('disabled' in button) button.disabled = false
        if (label) label.textContent = originalLabel
        button.title = originalTitle
        button.setAttribute('aria-label', originalAriaLabel)
      }, 2200)
    }
  }

  function favoriteControls() {
    return Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')).filter((node) => {
      if (node.closest?.('[data-nekobooru-site-import]')) return false
      const label = [node.id, node.className, node.textContent, node.value, node.title, node.getAttribute('aria-label')]
        .map((part) => String(part || ''))
        .join(' ')
      return /favou?rite/i.test(label)
    })
  }

  function booruActionFavoriteControl() {
    return core.selectGelbooruActionFavorite(favoriteControls())
  }

  function safebooruPostActionRow() {
    const actionRow = document.querySelector('.image-sublinks')
    if (actionRow) return actionRow
    return Array.from(document.querySelectorAll('h3, h4')).find((node) => {
      const label = String(node.textContent || '')
      return /\bedit\b/i.test(label) && /\b(respond|comment)\b/i.test(label)
    }) || null
  }

  function pixivShareControl() {
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter((node) => (
      !node.closest?.('[data-nekobooru-site-import]')
    ))
    return core.selectPixivShareControl(controls)
  }

  function injectPixivButton() {
    if (!core.pixivArtworkId(location.href)) return
    const share = pixivShareControl()
    if (!share?.parentElement) return
    const parent = share.parentElement
    const existing = Array.from(parent.children).find((node) => (
      node.dataset?.nekobooruSiteImport === 'pixiv'
    ))
    if (existing) {
      // Pixiv can reorder or replace controls without removing the toolbar.
      // Keep our existing button immediately after the current Share control.
      if (existing.previousElementSibling !== share) share.insertAdjacentElement('afterend', existing)
      return
    }
    share.insertAdjacentElement('afterend', createPixivIconButton(share))
  }

  // Danbooru: a "NekoBooru" tab right of Comments | Recommended under the post,
  // styled like its neighbours. Pages without that menu get an entry in the
  // sidebar's Options list instead.
  function injectDanbooruButton() {
    if (!core.danbooruPostId(location.href)) return
    if (document.querySelector('[data-nekobooru-site-import="danbooru"]')) return
    const sections = core.selectDanbooruSectionsAnchor(document)
    const anchor = sections || core.selectDanbooruOptionsAnchor(document)
    if (!anchor) return
    const item = document.createElement('li')
    item.id = sections ? 'post-section-nekobooru' : 'post-option-nekobooru'
    item.appendChild(createInlineLink(sections ? 'NekoBooru' : 'Import to NekoBooru', 'danbooru'))
    if (anchor.after) anchor.after.insertAdjacentElement('afterend', item)
    else anchor.list.appendChild(item)
  }

  function injectBooruButton() {
    if (DANBOORU_HOST) return injectDanbooruButton()
    const postId = GELBOORU_HOST ? core.gelbooruPostId(location.href) : core.safebooruPostId(location.href)
    if (!postId) return
    if (document.querySelector(`[data-nekobooru-site-import="${BOORU_KIND}"]`)) return
    const insertionPoint = SAFEBOORU_HOST ? safebooruPostActionRow() : booruActionFavoriteControl()
    if (!insertionPoint) return
    if (GELBOORU_HOST && !insertionPoint.parentElement) return
    const wrapper = document.createElement('span')
    wrapper.dataset.nekobooruSiteImport = 'wrapper'
    wrapper.appendChild(document.createTextNode(' | '))
    wrapper.appendChild(createInlineLink('NekoBooru', BOORU_KIND))
    if (SAFEBOORU_HOST) insertionPoint.appendChild(wrapper)
    else insertionPoint.insertAdjacentElement('afterend', wrapper)
  }

  const SANKAKU_TITLE = "Import Sankaku's original-resolution file and tags to NekoBooru"

  // The post sidebar's "Actions:" list opens with "Find similar"; the import
  // link goes right under it, in the same form as its neighbours.
  function sankakuFindSimilarAction() {
    return Array.from(document.querySelectorAll('a')).find((anchor) => (
      /^find similar$/i.test(anchor.textContent.trim()) && !anchor.closest('[data-nekobooru-sankaku-slot]')
    )) || null
  }

  function injectSankakuActionLink(findSimilar) {
    // A bare copy of the neighbour inherits the list's styling but none of its
    // id/class hooks, so the site's own click handlers cannot fire on it.
    const link = document.createElement('a')
    link.href = '#'
    link.dataset.nekobooruSiteImport = 'sankaku'
    link.dataset.nekobooruBusy = 'false'
    link.title = SANKAKU_TITLE
    link.setAttribute('aria-label', SANKAKU_TITLE)
    const text = document.createElement('span')
    text.dataset.nekobooruImportLabel = 'true'
    text.textContent = 'Import to NekoBooru'
    link.appendChild(text)
    link.addEventListener('click', handleImportClick)

    const row = findSimilar.parentElement?.tagName === 'LI' ? findSimilar.parentElement : null
    const slot = document.createElement(row ? 'li' : 'span')
    slot.dataset.nekobooruSankakuSlot = 'actions'
    if (!row) slot.appendChild(document.createElement('br'))
    slot.appendChild(link)
    ;(row || findSimilar).insertAdjacentElement('afterend', slot)
  }

  // Styled inline: a page CSP may refuse the injected <style> element, and an
  // unstyled button would land unseen at the very bottom of the page.
  function injectSankakuFloatingButton() {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.nekobooruSiteImport = 'sankaku'
    button.dataset.nekobooruSankakuSlot = 'floating'
    button.dataset.nekobooruBusy = 'false'
    button.title = SANKAKU_TITLE
    button.setAttribute('aria-label', SANKAKU_TITLE)
    Object.assign(button.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483000',
      padding: '8px 14px',
      border: '0',
      borderRadius: '999px',
      background: '#e8618c',
      color: '#fff',
      font: '600 13px/1.2 system-ui, sans-serif',
      boxShadow: '0 4px 14px rgba(0, 0, 0, .3)',
      cursor: 'pointer',
    })
    const text = document.createElement('span')
    text.dataset.nekobooruImportLabel = 'true'
    text.textContent = 'NekoBooru'
    button.appendChild(text)
    button.addEventListener('click', handleImportClick)
    document.body.appendChild(button)
  }

  const CAT_ICON = '<path d="M5 3.5 8.5 7.5h7L19 3.5V13a7 7 0 0 1-14 0Z"></path>' +
    '<circle cx="9.5" cy="12.5" r="1" fill="currentColor" stroke="none"></circle>' +
    '<circle cx="14.5" cy="12.5" r="1" fill="currentColor" stroke="none"></circle>' +
    '<path d="M10.9 15.4h2.2L12 16.6Z" fill="currentColor"></path>'

  function sankakuFlagControl() {
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter((node) => (
      !node.closest('[data-nekobooru-sankaku-slot]')
    ))
    return core.selectSankakuFlagControl(controls)
  }

  // The colour the neighbouring icons are drawn in, so the cat matches them
  // rather than the flag's red.
  function sankakuToolbarIconColor(flag) {
    const row = flag.parentElement?.parentElement || flag.parentElement
    const outside = (node) => !flag.contains(node)
    // Only real colours: not none/transparent, not the unpainted black default.
    const usable = (value) => /^rgba?\(/.test(value || '') && !/^rgba?\(0, 0, 0(, 0)?\)$/.test(value)
    const shapes = Array.from(row?.querySelectorAll('svg path, svg circle, svg rect, svg polygon') || []).filter(outside)
    for (const shape of shapes) {
      const style = getComputedStyle(shape)
      if (usable(style.fill)) return style.fill
      if (usable(style.stroke)) return style.stroke
    }
    for (const icon of Array.from(row?.querySelectorAll('svg') || []).filter(outside)) {
      const value = getComputedStyle(icon).color
      if (usable(value)) return value
    }
    return '#f46b1b'
  }

  // A copy of the flag control keeps the row's size and spacing; the site's
  // React handlers live on the original's props, not the cloned DOM, so only
  // ours runs on it.
  function createCatIcon(rect, color) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '2')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    icon.setAttribute('aria-hidden', 'true')
    if (rect.width > 0 && rect.height > 0) {
      icon.setAttribute('width', String(Math.round(rect.width)))
      icon.setAttribute('height', String(Math.round(rect.height)))
    }
    icon.style.color = color
    icon.innerHTML = CAT_ICON
    return icon
  }

  function listenForImport(button) {
    button.addEventListener('click', handleImportClick)
    // Some sites act on press rather than click; keep both to ourselves.
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'touchstart']) {
      button.addEventListener(type, (event) => event.stopPropagation())
    }
  }

  // sankaku.app's post sidebar: stars, then a heart with the favourite count,
  // then a comment bubble with its count:
  //   <div><svg data-test="fav" class="... canceledHandle">...</svg><span>41</span></div>
  // Material icons label themselves data-testid="FavoriteBorderIcon" instead.
  // Production builds can drop those labels, so the icons' standard Material
  // path data identifies them as well.
  const HEART_LABEL = /(^|[^a-z])(fav|favou?rite|heart|like)([^a-z]|$)|favou?rite/i
  const COMMENT_LABEL = /(^|[^a-z])(chat|comment|bubble)/i
  const HEART_PATHS = ['M16.5 3c-1.74 0-3.41.81-4.5 2.09', 'M12 21.35l-1.45-1.32']
  const COMMENT_PATHS = ['M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14', 'M21.99 4c0-1.1-.89-2-1.99-2H4']

  function svgDrawsOneOf(svg, prefixes) {
    return Array.from(svg.querySelectorAll('path')).some((path) => {
      const d = String(path.getAttribute('d') || '').replace(/\s+/g, ' ').trim()
      return prefixes.some((prefix) => d.startsWith(prefix))
    })
  }

  function isHeartIcon(svg) {
    return HEART_LABEL.test(svgLabel(svg)) || svgDrawsOneOf(svg, HEART_PATHS)
  }

  function isCommentIcon(svg) {
    return COMMENT_LABEL.test(svgLabel(svg)) || svgDrawsOneOf(svg, COMMENT_PATHS)
  }

  function svgLabel(svg) {
    const control = svg.closest('button, a, [role="button"]')
    return [
      svg.getAttribute('data-testid'),
      svg.getAttribute('data-test'),
      svg.getAttribute('aria-label'),
      svg.getAttribute('class'),
      svg.querySelector('title')?.textContent,
      control?.getAttribute('aria-label'),
      control?.getAttribute('title'),
      control?.getAttribute('data-testid'),
      control?.getAttribute('data-test'),
    ].map((part) => String(part || '')).join(' ')
  }

  // An icon's own group (icon plus its count): its highest ancestor that
  // holds no other icon.
  function iconGroup(svg) {
    let item = svg
    while (item.parentElement && item.parentElement !== document.body && item.parentElement.querySelectorAll('svg').length === 1) {
      item = item.parentElement
    }
    return item
  }

  // The post's heart: the one whose row also holds the comment bubble, or
  // failing that one shown with a count. A heart on a menu entry ("Favorites")
  // has neither.
  function sankakuAppHeartGroup() {
    const candidates = []
    for (const heart of document.querySelectorAll('svg')) {
      if (heart.closest('[data-nekobooru-sankaku-slot]') || !isHeartIcon(heart)) continue
      const group = iconGroup(heart)
      const row = group.parentElement
      // A lone heart's "row" can grow into the whole page; a real stats row
      // is a small container of a few icons.
      if (!row || row === document.body || row === document.documentElement) continue
      const rowIcons = Array.from(row.querySelectorAll('svg'))
      if (rowIcons.length > 8) continue
      if (rowIcons.some((svg) => svg !== heart && isCommentIcon(svg))) return { heart, group }
      if (/^\s*[\d.,]+\s*[kKmM]?\s*$/.test(group.textContent || '')) candidates.push({ heart, group })
    }
    return candidates[0] || null
  }

  // A cat in the heart's colour, immediately left of the heart.
  function injectSankakuHeartButton({ heart, group }) {
    const style = getComputedStyle(heart)
    const color = /^rgba?\(/.test(style.color || '') ? style.color : '#9e9e9e'
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.nekobooruSiteImport = 'sankaku'
    button.dataset.nekobooruSankakuSlot = 'heart'
    button.dataset.nekobooruBusy = 'false'
    button.title = SANKAKU_TITLE
    button.setAttribute('aria-label', SANKAKU_TITLE)
    Object.assign(button.style, {
      display: 'inline-flex',
      alignItems: 'center',
      background: 'transparent',
      border: '0',
      padding: '0',
      margin: '0 12px 0 0',
      cursor: 'pointer',
      color,
      lineHeight: '1',
    })
    const rect = heart.getBoundingClientRect()
    button.appendChild(createCatIcon(rect.width > 0 ? rect : { width: 24, height: 24 }, color))
    listenForImport(button)
    group.insertAdjacentElement('beforebegin', button)
  }

  const COPIED_STYLE_PROPERTIES = [
    'display', 'box-sizing', 'position', 'width', 'height', 'min-width', 'min-height',
    'margin', 'padding', 'border', 'border-radius', 'background-color', 'color',
    'cursor', 'align-items', 'justify-content', 'flex', 'gap', 'line-height', 'vertical-align',
  ]

  function injectSankakuToolbarButton(flag) {
    const color = sankakuToolbarIconColor(flag)
    const rect = (flag.querySelector('svg, img') || flag).getBoundingClientRect()
    // Copy the flag's whole slot in the row when it sits in a wrapper of its
    // own, so the cat lands beside it rather than inside it.
    let item = flag
    while (item.parentElement && item.parentElement.children.length === 1 && item.parentElement !== document.body) {
      item = item.parentElement
    }
    // Only the flag's look is copied. Its class, id, data and aria hooks are
    // what Sankaku's own report script finds it by (clicking the flag scrolls
    // to the report form), so they are frozen into inline styles and dropped.
    const button = item.cloneNode(true)
    const originals = [item, ...item.querySelectorAll('*')]
    ;[button, ...button.querySelectorAll('*')].forEach((node, index) => {
      const computed = originals[index] && getComputedStyle(originals[index])
      if (computed) {
        for (const property of COPIED_STYLE_PROPERTIES) {
          node.style.setProperty(property, computed.getPropertyValue(property))
        }
      }
      for (const name of Array.from(node.getAttributeNames())) {
        if (!['style', 'viewBox', 'd', 'fill', 'stroke', 'width', 'height', 'xmlns'].includes(name)) node.removeAttribute(name)
      }
      if (node.tagName === 'BUTTON') node.type = 'button'
      if (node.tagName === 'A') node.setAttribute('href', '#')
    })
    button.dataset.nekobooruSiteImport = 'sankaku'
    button.dataset.nekobooruSankakuSlot = 'toolbar'
    button.dataset.nekobooruBusy = 'false'
    button.title = SANKAKU_TITLE
    button.setAttribute('aria-label', SANKAKU_TITLE)

    const icon = createCatIcon(rect, color)
    const original = button.querySelector('svg, img')
    if (original) original.replaceWith(icon)
    else button.replaceChildren(icon)
    listenForImport(button)
    item.insertAdjacentElement('afterend', button)
  }

  // Classic Sankaku Channel gets a cat icon after the flag under the post and a
  // link in its Actions list. Where neither anchor exists (sankaku.app's
  // layout), a floating button stands in. All follow client-side navigation in
  // and out of post pages.
  function injectSankakuButton() {
    const slots = Array.from(document.querySelectorAll('[data-nekobooru-sankaku-slot]'))
    if (!core.sankakuPostId(location.href)) {
      slots.forEach((node) => node.remove())
      return
    }
    if (!document.body) return
    const slot = (kind) => slots.find((node) => node.dataset.nekobooruSankakuSlot === kind)
    // Each front-end gets only its own anchors: chan's flag row and Actions
    // list, sankaku.app's heart.
    const appLayout = location.hostname.replace(/^www\./, '').toLowerCase() === 'sankaku.app'
    const findSimilar = appLayout ? null : sankakuFindSimilarAction()
    const flag = appLayout ? null : sankakuFlagControl()
    const heart = appLayout ? sankakuAppHeartGroup() : null
    if (findSimilar && !slot('actions')) injectSankakuActionLink(findSimilar)
    if (flag && !slot('toolbar')) {
      try { injectSankakuToolbarButton(flag) } catch { /* the Actions link still works */ }
    }
    if (heart && !slot('heart')) injectSankakuHeartButton(heart)
    if (findSimilar || flag || heart) slot('floating')?.remove()
    else if (!slot('actions') && !slot('toolbar') && !slot('heart') && !slot('floating')) injectSankakuFloatingButton()
  }

  function scan() {
    installStyle()
    if (PIXIV_HOST) injectPixivButton()
    if (BOORU_KIND) injectBooruButton()
    if (SANKAKU_HOST) injectSankakuButton()
  }

  scan()
  const observer = new MutationObserver(scan)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  setInterval(scan, 1500)
})()
