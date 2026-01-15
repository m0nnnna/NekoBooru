<template>
  <div
    class="media-viewer"
    ref="containerRef"
    @wheel.prevent="onWheel"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @mouseleave="onMouseUp"
  >
    <div class="media-wrapper" :style="wrapperStyle">
      <img
        v-if="isImage"
        :src="src"
        :alt="alt"
        @load="onLoad"
        @error="onError"
        draggable="false"
        ref="mediaRef"
      />
      <video
        v-else-if="isVideo"
        :src="src"
        controls
        autoplay
        loop
        @loadedmetadata="onVideoLoad"
        @error="onError"
        ref="mediaRef"
      />
    </div>

    <div v-if="error" class="error-state">
      <span class="error-icon">&#9888;</span>
      <p>Failed to load media</p>
      <p class="error-url">{{ src }}</p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>Loading...</p>
    </div>

    <button class="close-button" @click="handleClose" title="Close (Esc)">
      <span>×</span>
    </button>

    <div class="controls" v-if="!error && !loading">
      <button @click="zoomOut" title="Zoom out">-</button>
      <span class="zoom-level">{{ Math.round(scale * 100) }}%</span>
      <button @click="zoomIn" title="Zoom in">+</button>
      <button @click="resetZoom" title="Reset">1:1</button>
      <button @click="fitToScreen" title="Fit to screen">Fit</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted as onMountedHook, onUnmounted } from 'vue'

const props = defineProps({
  src: {
    type: String,
    required: true,
  },
  alt: {
    type: String,
    default: '',
  },
  type: {
    type: String,
    default: 'image',
  },
})

const emit = defineEmits(['close'])

function handleClose() {
  emit('close')
}

const containerRef = ref(null)
const mediaRef = ref(null)
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const isDragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const mediaSize = ref({ width: 0, height: 0 })
const loading = ref(true)
const error = ref(false)

const isImage = computed(() => props.type === 'image' || props.type === 'gif')
const isVideo = computed(() => props.type === 'video')

const wrapperStyle = computed(() => ({
  transform: `translate(calc(-50% + ${translateX.value}px), calc(-50% + ${translateY.value}px)) scale(${scale.value})`,
  opacity: loading.value || error.value ? 0 : 1,
}))

function onLoad(e) {
  loading.value = false
  error.value = false
  const el = e.target
  mediaSize.value = {
    width: el.naturalWidth,
    height: el.naturalHeight,
  }
  nextTick(() => fitToScreen())
}

function onVideoLoad(e) {
  loading.value = false
  error.value = false
  const el = e.target
  mediaSize.value = {
    width: el.videoWidth,
    height: el.videoHeight,
  }
  nextTick(() => fitToScreen())
}

function onError() {
  loading.value = false
  error.value = true
}

function onWheel(e) {
  if (error.value) return
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  const newScale = Math.max(0.1, Math.min(10, scale.value + delta))
  scale.value = newScale
}

function onMouseDown(e) {
  if (e.button !== 0 || error.value) return
  isDragging.value = true
  dragStart.value = {
    x: e.clientX - translateX.value,
    y: e.clientY - translateY.value,
  }
}

function onMouseMove(e) {
  if (!isDragging.value) return
  translateX.value = e.clientX - dragStart.value.x
  translateY.value = e.clientY - dragStart.value.y
}

function onMouseUp() {
  isDragging.value = false
}

function zoomIn() {
  scale.value = Math.min(10, scale.value + 0.25)
}

function zoomOut() {
  scale.value = Math.max(0.1, scale.value - 0.25)
}

function resetZoom() {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
}

function fitToScreen() {
  if (!containerRef.value || !mediaSize.value.width) return

  const container = containerRef.value.getBoundingClientRect()
  const padding = 40
  const scaleX = (container.width - padding) / mediaSize.value.width
  const scaleY = (container.height - padding) / mediaSize.value.height
  scale.value = Math.min(scaleX, scaleY, 1)
  translateX.value = 0
  translateY.value = 0
}

// Reset on src change
watch(() => props.src, () => {
  loading.value = true
  error.value = false
  resetZoom()
})

// Handle Escape key to close
function onKeyDown(e) {
  if (e.key === 'Escape') {
    handleClose()
  }
}

// Add keyboard listener
onMountedHook(() => {
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped>
.media-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  border-radius: 0.5rem;
  min-height: 0;
  min-width: 0;
}

.media-viewer:active {
  cursor: grabbing;
}

.media-wrapper {
  position: absolute;
  top: 50%;
  left: 50%;
  transform-origin: center center;
  transition: transform 0.1s ease-out, opacity 0.3s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.media-wrapper img,
.media-wrapper video {
  max-width: none;
  max-height: none;
  display: block;
  border-radius: 0.25rem;
}

.controls {
  position: absolute;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--bg-primary);
  padding: 0.5rem 1rem;
  border-radius: 2rem;
  border: 1px solid var(--border);
  box-shadow: 0 4px 12px var(--shadow);
}

.controls button {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 0.35rem 0.75rem;
  border-radius: 0.25rem;
  font-weight: 500;
}

.controls button:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.zoom-level {
  color: var(--text-secondary);
  font-size: 0.875rem;
  min-width: 3rem;
  text-align: center;
}

.loading-state,
.error-state {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: var(--text-secondary);
}

.error-state {
  color: var(--coral);
}

.error-icon {
  font-size: 3rem;
}

.error-url {
  font-size: 0.75rem;
  max-width: 300px;
  word-break: break-all;
  opacity: 0.7;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.close-button {
  position: absolute;
  top: 1rem;
  right: 1rem;
  width: 40px;
  height: 40px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 1.5rem;
  color: var(--text-primary);
  z-index: 10;
  transition: all 0.2s;
  box-shadow: 0 2px 8px var(--shadow);
}

.close-button:hover {
  background: var(--coral);
  border-color: var(--coral);
  color: white;
  transform: scale(1.1);
}

.close-button span {
  line-height: 1;
  font-weight: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: -2px;
}
</style>
