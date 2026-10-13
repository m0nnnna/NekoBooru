<template>
  <div
    class="remote-card"
    :class="{ selectable: selectMode, selected, unavailable: Boolean(post.unavailable) }"
    role="button"
    tabindex="0"
    :aria-label="`${siteLabel} post ${post.id}`"
    :aria-pressed="selectMode ? selected : undefined"
    @click="onClick"
    @keydown.enter.prevent="onClick"
    @pointerdown="onPointerDown"
    @pointerup="clearHoldTimer"
    @pointercancel="clearHoldTimer"
    @pointerleave="clearHoldTimer"
    @pointerenter="onPointerEnter"
  >
    <div class="thumb-container">
      <img
        v-if="post.thumbUrl && !failed"
        :src="post.thumbUrl"
        :alt="`${siteLabel} #${post.id}`"
        :referrerpolicy="referrerPolicy"
        loading="lazy"
        draggable="false"
        @error="onThumbError"
      />
      <div v-else class="thumb-placeholder">
        <span class="placeholder-site">{{ siteLabel }}</span>
        <span class="placeholder-id">#{{ post.id }}</span>
      </div>
      <span class="badge site-badge" :class="`site-${post.site}`">{{ siteShort }}</span>
      <span v-if="post.mediaType === 'video'" class="badge video-badge">&#9658;</span>
      <span v-else-if="post.mediaType === 'gif'" class="badge gif-badge">GIF</span>
      <router-link
        v-if="inLibraryPostId"
        class="badge library-badge"
        :to="`/post/${inLibraryPostId}`"
        title="Already in NekoBooru - open the local copy"
        @click.stop
        @pointerdown.stop
      >in library</router-link>
      <div v-if="post.unavailable" class="unavailable-overlay">{{ unavailableText }}</div>
      <div v-if="selectMode" class="select-check" :class="{ on: selected }" aria-hidden="true">
        <span v-if="selected">&#10003;</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { adapterFor } from '../../remote/adapters/index.js'
import { imageReferrerPolicy, siteById } from '../../remote/types.js'

// One booru post in the home grid. Same hold/shift/pointer contract as
// PostCard.vue, but every payload is the post's string key ('danbooru:123')
// and a plain click opens the booru post page (the `open` event).
const HOLD_MS = 550
const SHORT_LABELS = { danbooru: 'Dan', e621: 'e621', sankaku: 'San', gelbooru: 'Gel', safebooru: 'Safe' }
const UNAVAILABLE_TEXT = {
  hidden: 'Hidden for guests',
  deleted: 'Deleted',
  banned: 'Banned',
  'no-file': 'No file',
}

const props = defineProps({
  post: { type: Object, required: true },
  selectMode: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  inLibraryPostId: { type: Number, default: null },
})

const emit = defineEmits(['toggle', 'hold-select', 'hover-post', 'open'])

const failed = ref(false)
const siteLabel = computed(() => siteById(props.post.site)?.label || props.post.site)
const referrerPolicy = computed(() => imageReferrerPolicy(props.post.site))
const siteShort = computed(() => SHORT_LABELS[props.post.site] || props.post.site)
const unavailableText = computed(() => UNAVAILABLE_TEXT[props.post.unavailable] || 'Unavailable')

watch(() => props.post.thumbUrl, () => { failed.value = false })

// Sankaku's signed previews expire (~8 h): the first failure of an expired
// one asks the adapter for a fresh URL and swaps it into the post; anything
// else, or a second failure, shows the placeholder.
let thumbRefreshed = false
watch(() => props.post.key, () => { thumbRefreshed = false })

async function onThumbError() {
  const post = props.post
  const adapter = adapterFor(post.site)
  if (!thumbRefreshed && adapter?.thumbExpired?.(post) && typeof adapter.refreshThumb === 'function') {
    thumbRefreshed = true
    let fresh = null
    try {
      fresh = await adapter.refreshThumb(post)
    } catch {
      fresh = null
    }
    if (fresh && fresh !== post.thumbUrl && props.post === post) {
      post.thumbUrl = fresh
      return
    }
  }
  failed.value = true
}

let holdTimer = null
let holdTriggered = false

function onClick(e) {
  if (holdTriggered) {
    holdTriggered = false
    return
  }
  if (props.selectMode) {
    emit('toggle', { key: props.post.key, shiftKey: Boolean(e.shiftKey) })
    return
  }
  emit('open', props.post.key)
}

function onPointerDown(e) {
  if (e.button != null && e.button !== 0) return
  clearHoldTimer()
  holdTriggered = false
  holdTimer = setTimeout(() => {
    holdTriggered = true
    emit('hold-select', props.post.key)
  }, HOLD_MS)
}

function onPointerEnter() {
  if (props.selectMode) emit('hover-post', props.post.key)
}

function clearHoldTimer() {
  if (holdTimer) {
    clearTimeout(holdTimer)
    holdTimer = null
  }
}

onBeforeUnmount(clearHoldTimer)
</script>

<style scoped>
.remote-card {
  display: block;
  position: relative;
  background: var(--bg-secondary);
  border-radius: 0.75rem;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  border: 2px solid transparent;
  content-visibility: auto;
  contain-intrinsic-size: 180px 180px;
  user-select: none;
}

.remote-card:hover,
.remote-card:focus-visible {
  transform: translateY(-4px) rotate(0.5deg);
  box-shadow: 0 8px 24px var(--shadow);
  border-color: var(--accent);
  outline: none;
}

.remote-card.selectable:hover {
  transform: none;
}

.remote-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}

.thumb-container {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.thumb-container img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}

.remote-card:hover .thumb-container img {
  transform: scale(1.05);
}

.thumb-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.placeholder-site {
  font-weight: 700;
}

.badge {
  position: absolute;
  padding: 0.2rem 0.45rem;
  font-size: 0.68rem;
  font-weight: 700;
  border-radius: 0.25rem;
  text-transform: uppercase;
  line-height: 1.2;
}

.site-badge {
  top: 0.5rem;
  right: 0.5rem;
  background: rgba(0, 0, 0, 0.7);
  color: white;
}

.site-danbooru { background: #0073ff; }
.site-e621 { background: #1f3c67; }
.site-sankaku { background: #ff761c; }
.site-gelbooru { background: #006ffa; }
.site-safebooru { background: #3b8a5a; }

.video-badge,
.gif-badge {
  bottom: 0.5rem;
  right: 0.5rem;
  background: rgba(0, 0, 0, 0.75);
  color: white;
}

.gif-badge {
  background: var(--success);
}

.library-badge {
  bottom: 0.5rem;
  left: 0.5rem;
  background: var(--success);
  color: white;
  text-decoration: none;
  text-transform: none;
}

.unavailable-overlay {
  position: absolute;
  inset: auto 0 0 0;
  padding: 0.35rem;
  background: rgba(0, 0, 0, 0.65);
  color: white;
  font-size: 0.75rem;
  text-align: center;
}

.remote-card.unavailable img {
  opacity: 0.55;
}

.select-check {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid white;
  background: rgba(0, 0, 0, 0.45);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  font-weight: 700;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}

.select-check.on {
  background: var(--accent);
}
</style>
