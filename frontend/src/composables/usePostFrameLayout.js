// The post frame's layout toggles: wide frame, hidden sidebar and the zoom-in
// as a post opens, saved per browser. Shared by the library and booru post pages.
import { ref } from 'vue'

export function usePostFrameLayout() {
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

  return {
    wideFrame,
    sidebarHidden,
    zoomAnimation,
    toggleWideFrame,
    toggleZoomAnimation,
    toggleSidebarHidden,
  }
}
