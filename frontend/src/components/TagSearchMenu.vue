<template>
  <span ref="root" class="tag-search-menu">
    <button
      ref="trigger"
      type="button"
      class="tag-search-trigger"
      :class="triggerClass"
      :style="triggerStyle"
      :title="title || `Choose where to search for ${tag}`"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggleMenu"
      @keydown.down.prevent="openMenu"
    >
      {{ label || tag }}
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menu"
        class="tag-search-dropdown"
        :class="{ 'dark-mode': darkMode }"
        role="menu"
        :aria-label="`Search options for ${tag}`"
        :style="menuStyle"
        @keydown.esc.stop.prevent="closeMenu(true)"
      >
        <router-link
          class="tag-search-option"
          role="menuitem"
          :to="{ path: '/', query: { q: tag } }"
          @click="closeMenu()"
        >
          Search in NekoBooru
        </router-link>
        <a
          class="tag-search-option"
          role="menuitem"
          :href="gelbooruUrl"
          target="_blank"
          rel="noopener noreferrer"
          @click="closeMenu()"
        >
          Search on Gelbooru <span aria-hidden="true">&#8599;</span>
        </a>
        <a
          class="tag-search-option"
          role="menuitem"
          :href="safebooruUrl"
          target="_blank"
          rel="noopener noreferrer"
          @click="closeMenu()"
        >
          Search on Safebooru <span aria-hidden="true">&#8599;</span>
        </a>
      </div>
    </Teleport>
  </span>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'

const props = defineProps({
  tag: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    default: '',
  },
  title: {
    type: String,
    default: '',
  },
  color: {
    type: String,
    default: '',
  },
  triggerClass: {
    type: [String, Array, Object],
    default: '',
  },
})

const root = ref(null)
const trigger = ref(null)
const menu = ref(null)
const open = ref(false)
const darkMode = ref(false)
const position = ref({ top: 0, left: 0 })

const triggerStyle = computed(() => (props.color ? { color: props.color } : undefined))
const menuStyle = computed(() => ({
  top: `${position.value.top}px`,
  left: `${position.value.left}px`,
}))
const gelbooruUrl = computed(() => booruSearchUrl('https://gelbooru.com', props.tag))
const safebooruUrl = computed(() => booruSearchUrl('https://safebooru.org', props.tag))

function booruSearchUrl(origin, tag) {
  return `${origin}/index.php?page=post&s=list&tags=${encodeURIComponent(tag)}`
}

function updatePosition() {
  if (!trigger.value || !menu.value) return
  const triggerRect = trigger.value.getBoundingClientRect()
  const menuRect = menu.value.getBoundingClientRect()
  const gutter = 8
  const gap = 5
  let top = triggerRect.bottom + gap
  let left = triggerRect.left

  if (top + menuRect.height > window.innerHeight - gutter) {
    top = Math.max(gutter, triggerRect.top - menuRect.height - gap)
  }
  if (left + menuRect.width > window.innerWidth - gutter) {
    left = Math.max(gutter, window.innerWidth - menuRect.width - gutter)
  }

  position.value = { top, left }
}

async function openMenu() {
  if (open.value) return
  darkMode.value = Boolean(root.value?.closest('.dark-mode'))
  open.value = true
  addOpenListeners()
  await nextTick()
  updatePosition()
  menu.value?.querySelector('[role="menuitem"]')?.focus()
}

function closeMenu(restoreFocus = false) {
  if (!open.value) return
  open.value = false
  removeOpenListeners()
  if (restoreFocus) nextTick(() => trigger.value?.focus())
}

function toggleMenu() {
  if (open.value) closeMenu()
  else openMenu()
}

function onPointerDown(event) {
  if (!open.value) return
  if (root.value?.contains(event.target) || menu.value?.contains(event.target)) return
  closeMenu()
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && open.value) closeMenu(true)
}

function addOpenListeners() {
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('resize', updatePosition)
  document.addEventListener('scroll', updatePosition, true)
}

function removeOpenListeners() {
  document.removeEventListener('pointerdown', onPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('resize', updatePosition)
  document.removeEventListener('scroll', updatePosition, true)
}

onBeforeUnmount(removeOpenListeners)
</script>

<style scoped>
.tag-search-menu {
  display: inline-flex;
  min-width: 0;
}

.tag-search-trigger {
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  line-height: inherit;
  text-align: left;
  overflow-wrap: anywhere;
}

.tag-search-trigger:hover,
.tag-search-trigger[aria-expanded='true'] {
  text-decoration: underline;
}

.tag-search-trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.tag-search-dropdown {
  position: fixed;
  z-index: 1000;
  display: grid;
  min-width: 190px;
  padding: 0.3rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
}

.tag-search-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.65rem;
  border-radius: 0.35rem;
  color: var(--text-primary);
  font-size: 0.85rem;
  line-height: 1.25;
  text-decoration: none;
  white-space: nowrap;
}

.tag-search-option:hover,
.tag-search-option:focus-visible {
  background: var(--bg-tertiary);
  color: var(--accent);
  outline: none;
}
</style>
