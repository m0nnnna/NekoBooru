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
      .nekobooru-site-import-button {
        align-items: center; background: #ff5c9a; border: 0; border-radius: 999px;
        box-shadow: 0 5px 18px rgba(0,0,0,.24); box-sizing: border-box;
        color: #fff !important; cursor: pointer; display: inline-flex; font: 700 13px/1.2 system-ui,sans-serif;
        gap: 6px; justify-content: center; margin: 0 6px; min-height: 32px; padding: 8px 13px;
        text-decoration: none !important; white-space: nowrap; z-index: 2147483646;
      }
      .nekobooru-site-import-button:hover { background: #ff3f87; }
      .nekobooru-site-import-button:disabled { cursor: wait; opacity: .72; }
      .nekobooru-site-import-floating { bottom: 24px; position: fixed; right: 24px; }
      .nekobooru-site-import-button svg { height: 16px; width: 16px; }
    `
    document.documentElement.appendChild(style)
  }

  function createButton(label, kind) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'nekobooru-site-import-button'
    button.dataset.nekobooruSiteImport = kind
    button.title = kind === 'pixiv'
      ? 'Import every original-resolution page to NekoBooru'
      : 'Import Gelbooru\'s original-resolution file and tags to NekoBooru'
    button.setAttribute('aria-label', button.title)
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5"></path><path d="M5 16v2.2A2.8 2.8 0 0 0 7.8 21h8.4a2.8 2.8 0 0 0 2.8-2.8V16"></path></svg><span>${label}</span>`
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
    return core.pixivImportJob(await metaResponse.json(), await pagesResponse.json(), location.href)
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
    if (button.disabled) return
    const label = button.querySelector('span')
    const originalLabel = label.textContent
    button.disabled = true
    label.textContent = 'Preparing…'
    try {
      const job = button.dataset.nekobooruSiteImport === 'pixiv' ? await pixivJob() : gelbooruJob()
      const response = await chrome.runtime.sendMessage({ type: 'nekobooru-open-site-import', job })
      if (!response?.ok) throw new Error(response?.error || 'The NekoBooru import window could not be opened.')
      label.textContent = 'Import opened'
    } catch (error) {
      label.textContent = 'Import failed'
      button.title = error?.message || String(error)
    } finally {
      setTimeout(() => {
        button.disabled = false
        label.textContent = originalLabel
      }, 2200)
    }
  }

  function favoriteControl() {
    return Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')).find((node) => {
      if (node.closest?.('[data-nekobooru-site-import]')) return false
      const label = [node.id, node.className, node.textContent, node.value, node.title, node.getAttribute('aria-label')]
        .map((part) => String(part || ''))
        .join(' ')
      return /favou?rite/i.test(label)
    })
  }

  function injectPixivButton() {
    if (!core.pixivArtworkId(location.href)) return
    if (document.querySelector('[data-nekobooru-site-import="pixiv"]')) return
    const button = createButton('Import all to NekoBooru', 'pixiv')
    button.classList.add('nekobooru-site-import-floating')
    document.body.appendChild(button)
  }

  function injectGelbooruButton() {
    if (!core.gelbooruPostId(location.href)) return
    if (document.querySelector('[data-nekobooru-site-import="gelbooru"]')) return
    const button = createButton('NekoBooru original', 'gelbooru')
    const favorite = favoriteControl()
    const item = favorite?.closest('li')
    if (item?.parentElement) {
      const wrapper = document.createElement('li')
      wrapper.dataset.nekobooruSiteImport = 'wrapper'
      wrapper.appendChild(button)
      item.insertAdjacentElement('afterend', wrapper)
    } else if (favorite?.parentElement) {
      favorite.insertAdjacentElement('afterend', button)
    } else {
      button.classList.add('nekobooru-site-import-floating')
      document.body.appendChild(button)
    }
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
