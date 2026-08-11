;(function installSiteImportButtons() {
  if (window.top !== window || !globalThis.NekoBooruSiteImport) return

  const core = globalThis.NekoBooruSiteImport
  const PIXIV_HOST = location.hostname === 'pixiv.net' || location.hostname.endsWith('.pixiv.net')
  const GELBOORU_HOST = location.hostname.replace(/^www\./, '') === 'gelbooru.com'
  if (!PIXIV_HOST && !GELBOORU_HOST) return

  function installStyle() {
    if (document.getElementById('nekobooru-site-import-style')) return
    const style = document.createElement('style')
    style.id = 'nekobooru-site-import-style'
    style.textContent = `
      .nekobooru-site-import-inline { cursor: pointer; font: inherit; white-space: nowrap; }
      [data-nekobooru-site-import][data-nekobooru-busy="true"] { cursor: wait !important; opacity: .65; }
    `
    document.documentElement.appendChild(style)
  }

  function createInlineLink(label, kind) {
    const link = document.createElement('a')
    link.href = '#'
    link.className = 'nekobooru-site-import-inline'
    link.dataset.nekobooruSiteImport = kind
    link.title = 'Import Gelbooru\'s original-resolution file and tags to NekoBooru'
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

  function gelbooruOriginalFallback() {
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
      fallbackOriginalUrl: gelbooruOriginalFallback(),
      title: `Gelbooru #${postId}`,
      groupTag: `gelbooru_${postId}`,
    }
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
      const job = button.dataset.nekobooruSiteImport === 'pixiv' ? await pixivJob() : gelbooruJob()
      const response = await chrome.runtime.sendMessage({ type: 'nekobooru-open-site-import', job })
      if (!response?.ok) throw new Error(response?.error || 'The NekoBooru import window could not be opened.')
      if (label) label.textContent = 'Import opened'
      button.title = 'NekoBooru import opened'
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

  function gelbooruActionFavoriteControl() {
    return core.selectGelbooruActionFavorite(favoriteControls())
  }

  function pixivShareControl() {
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter((node) => (
      !node.closest?.('[data-nekobooru-site-import]')
    ))
    return core.selectPixivShareControl(controls)
  }

  function injectPixivButton() {
    if (!core.pixivArtworkId(location.href)) return
    if (document.querySelector('[data-nekobooru-site-import="pixiv"]')) return
    const share = pixivShareControl()
    if (!share?.parentElement) return
    share.insertAdjacentElement('afterend', createPixivIconButton(share))
  }

  function injectGelbooruButton() {
    if (!core.gelbooruPostId(location.href)) return
    if (document.querySelector('[data-nekobooru-site-import="gelbooru"]')) return
    const favorite = gelbooruActionFavoriteControl()
    if (!favorite?.parentElement) return
    const wrapper = document.createElement('span')
    wrapper.dataset.nekobooruSiteImport = 'wrapper'
    wrapper.appendChild(document.createTextNode(' | '))
    wrapper.appendChild(createInlineLink('NekoBooru', 'gelbooru'))
    favorite.insertAdjacentElement('afterend', wrapper)
  }

  function scan() {
    installStyle()
    if (PIXIV_HOST) injectPixivButton()
    if (GELBOORU_HOST) injectGelbooruButton()
  }

  scan()
  const observer = new MutationObserver(scan)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  setInterval(scan, 1500)
})()
