// The post page's Similar and Search tabs: visually similar library posts,
// exact MD5 lookup, and reverse image search providers.
import { ref, computed } from 'vue'
import api from '../api/client'
import {
  SEARCH_PROVIDERS,
  blobToDataUrl,
  detectExtension,
  openSearchTarget,
  prepareSearchImage,
  requestExtensionReverseSearch,
  submitSearchFile,
} from '../utils/onlineImageSearch'
export function usePostPageSearch({ post, route, mediaType, mediaViewer }) {
  const similar = ref([])
  const similarLoading = ref(false)
  const similarLoaded = ref(false)
  const onlineExactLoading = ref(false)
  const onlineExactResult = ref(null)
  const onlineSearchBusy = ref('')
  const onlineSearchMessage = ref('')
  const onlineSearchMessageKind = ref('success')
  const extensionAvailable = ref(false)
  const onlineSearchProviders = computed(() => SEARCH_PROVIDERS.map((provider) => ({
    ...provider,
    usable: extensionAvailable.value || provider.direct,
  })))
  const onlineExactUnavailableProviders = computed(() => (
    (onlineExactResult.value?.providers || [])
      .filter((provider) => !provider.available)
      .map((provider) => provider.label)
  ))

  async function loadSimilar() {
    similarLoading.value = true
    try {
      const result = await api.getSimilarPosts(route.params.id)
      similar.value = result.results || []
      similarLoaded.value = true
    } catch (e) {
      alert('Failed to find similar posts: ' + e.message)
    } finally {
      similarLoading.value = false
    }
  }

  function setOnlineSearchMessage(message, kind = 'success') {
    onlineSearchMessage.value = message
    onlineSearchMessageKind.value = kind
  }

  async function findExactOnlineMatches() {
    if (!post.value?.id || onlineExactLoading.value) return
    onlineExactLoading.value = true
    setOnlineSearchMessage('Checking exact MD5 matches on Danbooru, Gelbooru, and Sankaku...')
    try {
      onlineExactResult.value = await api.getPostOnlineMatches(post.value.id)
      const count = onlineExactResult.value.matches?.length || 0
      setOnlineSearchMessage(
        count ? `Found ${count} byte-exact online match${count === 1 ? '' : 'es'}.` : 'Exact lookup finished; no identical files were found.',
        count ? 'success' : 'neutral',
      )
    } catch (error) {
      setOnlineSearchMessage('Exact lookup failed: ' + error.message, 'error')
    } finally {
      onlineExactLoading.value = false
    }
  }

  async function fileForVisualSearch() {
    if (mediaType.value === 'video') {
      const frame = await mediaViewer.value?.captureCurrentFrame?.()
      if (!frame) throw new Error('The current video frame is not ready yet.')
      const name = (post.value.filename || 'nekobooru-video').replace(/\.[^.]+$/, '')
      return new File([frame], `${name}-frame.png`, { type: 'image/png' })
    }

    const response = await fetch(post.value.contentUrl, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`Could not read the post image (HTTP ${response.status}).`)
    const blob = await response.blob()
    return new File([blob], post.value.filename || 'nekobooru-search-image', {
      type: blob.type || 'application/octet-stream',
    })
  }

  async function refreshExtensionAvailable() {
    if (!extensionAvailable.value) extensionAvailable.value = await detectExtension()
    return extensionAvailable.value
  }

  async function searchOnProvider(provider) {
    if (!post.value || onlineSearchBusy.value) return
    // Ask again on the click: the extension may have been reloaded since the page opened.
    if (!provider.usable && !await refreshExtensionAvailable()) {
      setOnlineSearchMessage(
        `${provider.label} needs the NekoBooru extension, and it is not answering on this page. ` +
          'Reload the extension on the extensions page, then refresh this page (reloading it does not reach tabs that were already open).',
        'error',
      )
      return
    }
    // Prefer the extension: it opens the tab itself and can fill TinEye and
    // trace.moe. Without it, the tab has to open now, while the click still
    // counts as a user gesture, or the popup blocker eats it.
    const viaExtension = extensionAvailable.value
    let searchTarget = null
    onlineSearchBusy.value = provider.id
    setOnlineSearchMessage(`Preparing the ${mediaType.value === 'video' ? 'frame' : 'image'} for ${provider.label}...`, 'neutral')
    try {
      if (!viaExtension) searchTarget = openSearchTarget(provider.id)
      const file = await prepareSearchImage(await fileForVisualSearch())
      if (viaExtension) {
        // The page sends the bytes: media URLs need this login, which the
        // extension's own fetch does not have.
        await requestExtensionReverseSearch({
          mode: provider.id,
          mediaUrl: new URL(post.value.contentUrl, window.location.href).href,
          mediaType: 'image',
          filename: file.name,
          dataUrl: await blobToDataUrl(file),
        }, { timeoutMs: 15000 })
      } else {
        submitSearchFile(provider.id, searchTarget.targetName, file)
      }
      setOnlineSearchMessage(`${provider.label} opened in a new tab.`, 'success')
    } catch (error) {
      try { searchTarget?.targetWindow?.close() } catch { /* best effort */ }
      setOnlineSearchMessage(`${provider.label} search failed: ${error.message}`, 'error')
    } finally {
      onlineSearchBusy.value = ''
    }
  }
  return {
    similar,
    similarLoading,
    similarLoaded,
    onlineExactLoading,
    onlineExactResult,
    onlineSearchBusy,
    onlineSearchMessage,
    onlineSearchMessageKind,
    extensionAvailable,
    onlineSearchProviders,
    onlineExactUnavailableProviders,
    loadSimilar,
    findExactOnlineMatches,
    refreshExtensionAvailable,
    searchOnProvider,
  }
}
