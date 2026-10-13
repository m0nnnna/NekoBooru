// Post page layout: the frame toggles (usePostFrameLayout) and which post
// tool tab is open.
import { ref, computed, watch } from 'vue'
import { usePostFrameLayout } from './usePostFrameLayout'

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
  const frame = usePostFrameLayout()

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
    ...frame,
    postToolTabs,
    activePostToolTab,
    selectPostToolTab,
  }
}
