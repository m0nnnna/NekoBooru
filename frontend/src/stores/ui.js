import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const sidebarOpen = ref(true)
  const lightboxOpen = ref(false)
  const lightboxIndex = ref(0)

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function openLightbox(index = 0) {
    lightboxIndex.value = index
    lightboxOpen.value = true
  }

  function closeLightbox() {
    lightboxOpen.value = false
  }

  function setLightboxIndex(index) {
    lightboxIndex.value = index
  }

  return {
    sidebarOpen,
    lightboxOpen,
    lightboxIndex,
    toggleSidebar,
    openLightbox,
    closeLightbox,
    setLightboxIndex,
  }
})
