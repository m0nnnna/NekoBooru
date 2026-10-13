// Post page layout: the wide-frame / hidden-sidebar / zoom-animation
// toggles (saved per browser) and which post tool tab is open.
import { ref, computed, watch } from 'vue'

export function usePostPageLayout({ autoTag, search, optimize }) {
  const { autoTagControlsVisible, autoTagLoading } = autoTag
  const { similarLoading, onlineExactLoading, onlineSearchBusy, refreshExtensionAvailable } = search
  const { optimizeBusy } = optimize

  const postToolTabs = computed(() => [
    ...(autoTagControlsVisible.value ? [{ id: 'ai', label: 'AI Tags', busy: autoTagLoading.value }] : []),
    { id: 'similar', label: 'Similar', busy: similarLoading.value },
    { id: 'search', label: 'Search', busy: onlineExactLoading.value || onlineSearchBusy.value !== '' },
    { id: 'optimize', label: 'Optimize', busy: optimizeBusy.value },
  ])
  const POST_LAYOUT_KEY = 'nekobooru.postLayout'
  const savedPostLayout = readPostLayout()
  const wideFrame = ref(savedPostLayout.wideFrame === true)
  const sidebarHidden = ref(savedPostLayout.sidebarHidden === true)
  // On unless turned off: the media eases into its fitted size as each post opens.
  // Saved per browser, so one person turning it off does not change it for others.
  const zoomAnimation = ref(savedPostLayout.zoomAnimation !== false)

  function readPostLayout() {
    try {
      return JSON.parse(localStorage.getItem(POST_LAYOUT_KEY) || '{}') || {}
    } catch {
      return {}
    }
  }

  function savePostLayout() {
    try {
      localStorage.setItem(POST_LAYOUT_KEY, JSON.stringify({
        wideFrame: wideFrame.value,
        sidebarHidden: sidebarHidden.value,
        zoomAnimation: zoomAnimation.value,
      }))
    } catch {
      // localStorage unavailable
    }
  }

  function toggleWideFrame() {
    wideFrame.value = !wideFrame.value
    savePostLayout()
  }

  function toggleZoomAnimation() {
    zoomAnimation.value = !zoomAnimation.value
    savePostLayout()
  }

  function toggleSidebarHidden() {
    sidebarHidden.value = !sidebarHidden.value
    savePostLayout()
  }

  // Opens on Similar each time the post page loads.
  const postToolTab = ref('similar')
  const activePostToolTab = computed(() =>
    postToolTabs.value.some((tab) => tab.id === postToolTab.value) ? postToolTab.value : 'similar'
  )

  function selectPostToolTab(id) {
    postToolTab.value = id
  }

  watch(activePostToolTab, (tab) => {
    if (tab === 'search') refreshExtensionAvailable()
  })
  return {
    wideFrame,
    sidebarHidden,
    zoomAnimation,
    toggleWideFrame,
    toggleZoomAnimation,
    toggleSidebarHidden,
    postToolTabs,
    activePostToolTab,
    selectPostToolTab,
  }
}
