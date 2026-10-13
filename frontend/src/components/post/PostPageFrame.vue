<template>
  <div
    class="post-view"
    :class="{ 'wide-frame': wideFrame, 'sidebar-hidden': sidebarHidden }"
  >
    <div class="post-content">
      <div class="media-container">
        <MediaViewer
          ref="viewer"
          :src="src"
          :alt="alt"
          :type="type"
          :animate-load="zoomAnimation"
          @close="$emit('close')"
        >
          <template #controls>
            <button
              type="button"
              class="layout-toggle"
              :class="{ active: zoomAnimation }"
              :title="zoomAnimation ? 'Turn off the zoom-in when a post opens' : 'Turn on the zoom-in when a post opens'"
              :aria-pressed="zoomAnimation"
              @click="$emit('toggle-zoom-animation')"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="6" />
                <path d="M20 20l-4.5-4.5M11 8v6M8 11h6" />
              </svg>
            </button>
            <button
              type="button"
              class="layout-toggle"
              :class="{ active: wideFrame }"
              :title="wideFrame ? 'Normal width' : 'Widen the frame to the full window'"
              :aria-pressed="wideFrame"
              @click="$emit('toggle-wide-frame')"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4" />
              </svg>
            </button>
            <button
              type="button"
              class="layout-toggle"
              :class="{ active: sidebarHidden }"
              :title="sidebarHidden ? 'Pin the sidebar' : 'Hide the sidebar (hover the right edge to peek)'"
              :aria-pressed="sidebarHidden"
              @click="$emit('toggle-sidebar-hidden')"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M15 4v16" />
              </svg>
            </button>
          </template>
        </MediaViewer>
        <button
          v-if="hasPrev"
          type="button"
          class="nav-arrow nav-prev"
          title="Previous post (Left arrow)"
          aria-label="Previous post"
          @click="$emit('prev')"
        >&#8249;</button>
        <button
          v-if="hasNext"
          type="button"
          class="nav-arrow nav-next"
          title="Next post (Right arrow)"
          aria-label="Next post"
          @click="$emit('next')"
        >&#8250;</button>
      </div>
    </div>

    <!-- With the sidebar hidden, this strip on the right edge brings it back on hover. -->
    <div v-if="sidebarHidden" class="sidebar-peek" aria-hidden="true"><span></span></div>
    <aside class="post-sidebar">
      <slot name="sidebar" />
    </aside>

    <slot />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import MediaViewer from '../MediaViewer.vue'

// The post page's frame: the media with its layout toggles and Prev / Next
// arrows, and the sidebar beside it (pinned, or hidden behind a hover strip).
// The page fills the sidebar slot; the default slot is for its dialogs.
defineProps({
  src: { type: String, required: true },
  alt: { type: String, default: '' },
  type: { type: String, default: 'image' },
  wideFrame: { type: Boolean, default: false },
  sidebarHidden: { type: Boolean, default: false },
  zoomAnimation: { type: Boolean, default: true },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
})

defineEmits(['close', 'prev', 'next', 'toggle-zoom-animation', 'toggle-wide-frame', 'toggle-sidebar-hidden'])

const viewer = ref(null)

// What the page's tools ask the viewer (see MediaViewer's defineExpose).
defineExpose({
  currentVideoTime: () => viewer.value?.currentVideoTime?.() ?? null,
  captureCurrentFrame: () => viewer.value?.captureCurrentFrame?.(),
})
</script>

<style scoped>
.post-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 1.5rem;
  height: calc(100vh - 120px);
}

.post-content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.media-container {
  position: relative;
  height: 100%;
  width: 100%;
  border-radius: 0.75rem;
  overflow: hidden;
  background: var(--bg-secondary);
}

.nav-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 64px;
  border: none;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.4);
  color: #fff;
  font-size: 2rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.15s, background 0.15s;
  /* The arrow is a text glyph; keep it from being selected or showing a text caret. */
  user-select: none;
  -webkit-user-select: none;
  caret-color: transparent;
}

.nav-arrow:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.65);
}

.nav-prev {
  left: 0.5rem;
}

.nav-next {
  right: 0.5rem;
}

@media (max-width: 480px) {
  .nav-arrow {
    width: 38px;
    height: 54px;
    font-size: 1.6rem;
  }
}

.post-sidebar {
  background: var(--bg-secondary);
  border-radius: 0.75rem;
  padding: 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  border: 1px solid var(--border);
}

/* Layout toggles in the viewer's control pill. */
.layout-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sidebar-peek {
  display: none;
}

@media (min-width: 769px) {
  .post-view {
    position: relative;
  }

  /* Hidden sidebar: the frame takes almost the whole row. A slim gutter of its
     own sits beside it (never over it, so the next arrow and the close button
     stay clickable), and hovering that gutter floats the sidebar in. */
  .post-view.sidebar-hidden {
    grid-template-columns: minmax(0, 1fr) 56px;
    gap: 0.5rem;
  }

  .post-view.sidebar-hidden .post-sidebar {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    width: 360px;
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.35);
    opacity: 0;
    transform: translateX(16px);
    pointer-events: none;
    transition: opacity 0.18s ease 0.25s, transform 0.18s ease 0.25s;
  }

  .post-view.sidebar-hidden .sidebar-peek:hover + .post-sidebar,
  .post-view.sidebar-hidden .post-sidebar:hover,
  .post-view.sidebar-hidden .post-sidebar:focus-within {
    opacity: 1;
    transform: none;
    pointer-events: auto;
    transition-delay: 0s;
  }

  .sidebar-peek {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    border: 1px solid transparent;
    border-radius: 0.75rem;
    cursor: w-resize;
    transition: background 0.15s, border-color 0.15s;
  }

  .sidebar-peek:hover {
    background: var(--bg-secondary);
    border-color: var(--border);
  }

  .sidebar-peek span {
    width: 4px;
    height: 64px;
    border-radius: 999px;
    background: var(--accent);
    opacity: 0.4;
    transition: opacity 0.15s;
  }

  .sidebar-peek:hover span {
    opacity: 0.85;
  }
}

@media (max-width: 768px) {
  .layout-toggle {
    display: none;
  }

  .post-view {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(300px, 60vh) auto;
    height: auto;
    gap: 1rem;
  }

  .post-content {
    min-height: 300px;
  }

  .media-container {
    border-radius: 0.5rem;
  }

  .post-sidebar {
    padding: 1rem;
    gap: 1rem;
    border-radius: 0.5rem;
  }
}

@media (max-width: 480px) {
  .post-view {
    grid-template-rows: minmax(250px, 50vh) auto;
    gap: 0.75rem;
  }

  .post-sidebar {
    padding: 0.875rem;
  }
}
</style>
