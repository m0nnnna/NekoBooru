<template>
  <div
    class="media-viewer"
    ref="containerRef"
    @wheel.prevent="onWheel"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @mouseleave="onMouseLeave"
    @touchstart="onTouchStart"
    @touchmove.prevent="onTouchMove"
    @touchend="onTouchEnd"
  >
    <div class="media-wrapper" :style="wrapperStyle">
      <img
        v-if="isImage"
        :src="src"
        :alt="alt"
        :referrerpolicy="referrerPolicy"
        @load="onLoad"
        @error="onError"
        draggable="false"
        ref="mediaRef"
      />
      <video
        v-else-if="isVideo"
        :src="src"
        :referrerpolicy="referrerPolicy"
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

    <div class="controls" :class="{ visible: controlsVisible }" v-if="!error && !loading">
      <button @click="zoomOut" title="Zoom out">-</button>
      <span class="zoom-level">{{ Math.round(scale * 100) }}%</span>
      <button @click="zoomIn" title="Zoom in">+</button>
      <button @click="resetZoom" title="Reset">1:1</button>
      <button @click="fitToScreen" title="Fit to screen">Fit</button>
      <button @click="downloadMedia" title="Download">&#8681;</button>
      <button v-if="isVideo && !isForeignSrc" @click="downloadAsGif" :disabled="convertingGif" title="Download as GIF">
        {{ convertingGif ? '…' : 'GIF' }}
      </button>
      <!-- Extra page-level buttons, e.g. the post page's layout toggles. -->
      <slot name="controls" />
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
  // Whether new media eases from 100% into its fitted size. Off, it appears
  // already fitted.
  animateLoad: {
    type: Boolean,
    default: true,
  },
  // Media from another site (booru search): load and download it without a
  // Referer, which some CDNs refuse when it names this app's origin.
  noReferrer: {
    type: Boolean,
    default: false,
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
const convertingGif = ref(false)
// True while the view is "fit to screen", so a resized frame refits instead of
// leaving the media at the old size. Any manual zoom or pan clears it.
const autoFit = ref(true)
// The control pill shows only while the pointer is in a centre column of the
// viewer (or on the pill itself), not anywhere over the media.
const controlsVisible = ref(false)
const CONTROLS_BAND_MIN_HALF_WIDTH = 220
let resizeObserver = null

// Touch handling state
const touchState = ref({
  initialDistance: 0,
  initialScale: 1,
  isPinching: false,
  lastTouchX: 0,
  lastTouchY: 0,
  isTouchDragging: false,
})

const referrerPolicy = computed(() => (props.noReferrer ? 'no-referrer' : undefined))
// Media on another origin (a booru's CDN): the server-side GIF conversion
// only exists for this app's own files, so its button is hidden.
const isForeignSrc = computed(() => {
  try {
    return new URL(props.src, window.location.origin).origin !== window.location.origin
  } catch {
    return false
  }
})
const isImage = computed(() => props.type === 'image' || props.type === 'gif')
const isVideo = computed(() => props.type === 'video')

// True from a new src until it has been fitted, so the fit can skip the
// zoom transition when animateLoad is off.
const settling = ref(true)

const wrapperStyle = computed(() => ({
  transform: `translate(calc(-50% + ${translateX.value}px), calc(-50% + ${translateY.value}px)) scale(${scale.value})`,
  opacity: loading.value || error.value ? 0 : 1,
  // Without the zoom-in: the outgoing media vanishes at once (a cached image
  // can load before a fade-out would finish, and show at the old size), then
  // the new one fades in only after it has been fitted.
  ...(settling.value && !props.animateLoad
    ? { transition: loading.value ? 'none' : 'opacity 0.15s ease-out' }
    : {}),
}))

function fitNewMedia() {
  // With the zoom-in on, the media fades in at 100% and eases to its fit.
  // Off, it stays invisible until it has been fitted, so it never shows for a
  // frame at the wrong size.
  if (props.animateLoad) loading.value = false
  nextTick(() => {
    fitToScreen()
    loading.value = false
    // Two frames: the fitted transform has to be painted before the
    // transition comes back, or it would animate anyway. Frames pause in a
    // background tab, so a timer ends it there instead.
    const done = () => { settling.value = false }
    requestAnimationFrame(() => requestAnimationFrame(done))
    setTimeout(done, 150)
  })
}

function onLoad(e) {
  error.value = false
  const el = e.target
  mediaSize.value = {
    width: el.naturalWidth,
    height: el.naturalHeight,
  }
  fitNewMedia()
}

function onVideoLoad(e) {
  error.value = false
  const el = e.target
  mediaSize.value = {
    width: el.videoWidth,
    height: el.videoHeight,
  }
  fitNewMedia()
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
  autoFit.value = false
}

function onMouseDown(e) {
  if (e.button !== 0 || error.value) return
  isDragging.value = true
  dragStart.value = {
    x: e.clientX - translateX.value,
    y: e.clientY - translateY.value,
  }
}

function updateControlsVisible(e) {
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  const halfWidth = Math.max(CONTROLS_BAND_MIN_HALF_WIDTH, rect.width * 0.12)
  controlsVisible.value = Math.abs(e.clientX - (rect.left + rect.width / 2)) <= halfWidth
}

function onMouseLeave() {
  onMouseUp()
  controlsVisible.value = false
}

function onMouseMove(e) {
  updateControlsVisible(e)
  if (!isDragging.value) return
  autoFit.value = false
  translateX.value = e.clientX - dragStart.value.x
  translateY.value = e.clientY - dragStart.value.y
}

function onMouseUp() {
  isDragging.value = false
}

// Touch event handlers
function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function onTouchStart(e) {
  if (error.value) return

  if (e.touches.length === 2) {
    // Pinch gesture start
    touchState.value.isPinching = true
    touchState.value.isTouchDragging = false
    touchState.value.initialDistance = getTouchDistance(e.touches)
    touchState.value.initialScale = scale.value
  } else if (e.touches.length === 1) {
    // Single finger drag start
    touchState.value.isTouchDragging = true
    touchState.value.isPinching = false
    touchState.value.lastTouchX = e.touches[0].clientX
    touchState.value.lastTouchY = e.touches[0].clientY
  }
}

function onTouchMove(e) {
  if (error.value) return
  autoFit.value = false

  if (touchState.value.isPinching && e.touches.length === 2) {
    // Pinch to zoom
    const currentDistance = getTouchDistance(e.touches)
    const scaleRatio = currentDistance / touchState.value.initialDistance
    const newScale = touchState.value.initialScale * scaleRatio
    scale.value = Math.max(0.1, Math.min(10, newScale))
  } else if (touchState.value.isTouchDragging && e.touches.length === 1) {
    // Single finger pan
    const deltaX = e.touches[0].clientX - touchState.value.lastTouchX
    const deltaY = e.touches[0].clientY - touchState.value.lastTouchY
    translateX.value += deltaX
    translateY.value += deltaY
    touchState.value.lastTouchX = e.touches[0].clientX
    touchState.value.lastTouchY = e.touches[0].clientY
  }
}

function onTouchEnd(e) {
  if (e.touches.length === 0) {
    touchState.value.isPinching = false
    touchState.value.isTouchDragging = false
  } else if (e.touches.length === 1) {
    // Switched from pinch to single finger
    touchState.value.isPinching = false
    touchState.value.isTouchDragging = true
    touchState.value.lastTouchX = e.touches[0].clientX
    touchState.value.lastTouchY = e.touches[0].clientY
  }
}

function zoomIn() {
  scale.value = Math.min(10, scale.value + 0.25)
  autoFit.value = false
}

function zoomOut() {
  scale.value = Math.max(0.1, scale.value - 0.25)
  autoFit.value = false
}

function resetZoom() {
  autoFit.value = false
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
}

function filenameFromSrc() {
  try {
    const path = new URL(props.src, window.location.origin).pathname
    return decodeURIComponent(path.split('/').pop()) || 'download'
  } catch {
    return 'download'
  }
}

async function downloadMedia() {
  // Fetch the media and trigger a real download. iOS Safari blocks the native
  // long-press save in this viewer (touch-callout/user-select are disabled for
  // pan/zoom), so this button gives a reliable way to save the file.
  try {
    const response = await fetch(props.src, props.noReferrer ? { referrerPolicy: 'no-referrer' } : undefined)
    if (!response.ok) throw new Error('fetch failed')
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filenameFromSrc()
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    // Fallback: open the media directly so the user can save it manually
    window.open(props.src, '_blank', props.noReferrer ? 'noopener,noreferrer' : undefined)
  }
}

async function downloadAsGif() {
  // Ask the server to transcode the video to an animated GIF and download it.
  if (convertingGif.value) return
  convertingGif.value = true
  try {
    const gifUrl = props.src + (props.src.includes('?') ? '&' : '?') + 'format=gif'
    const response = await fetch(gifUrl)
    if (!response.ok) throw new Error('conversion failed')
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filenameFromSrc().replace(/\.[^.]+$/, '') + '.gif'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    // Fallback: open the converted media directly so the user can save it
    window.open(props.src + (props.src.includes('?') ? '&' : '?') + 'format=gif', '_blank')
  } finally {
    convertingGif.value = false
  }
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
  autoFit.value = true
}

// Reset on src change
watch(() => props.src, () => {
  settling.value = true
  loading.value = true
  error.value = false
  // Resetting now would snap the outgoing media to 100% while it fades out;
  // without the zoom-in, the fit on load replaces the transform instead.
  if (props.animateLoad) resetZoom()
  else autoFit.value = true
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
  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      if (autoFit.value) fitToScreen()
    })
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  resizeObserver?.disconnect()
})

defineExpose({
  // Where the playhead is, so a caller can pin the frame the AI analyses.
  // Null for anything that is not a video.
  currentVideoTime: () => (isVideo.value ? Number(mediaRef.value?.currentTime) || 0 : null),
  captureCurrentFrame: () => {
    if (!isVideo.value || !mediaRef.value?.videoWidth || !mediaRef.value?.videoHeight) return null
    const canvas = document.createElement('canvas')
    canvas.width = mediaRef.value.videoWidth
    canvas.height = mediaRef.value.videoHeight
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(mediaRef.value, 0, 0, canvas.width, canvas.height)
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  },
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

/* Re-enable the iOS long-press "Save Image" menu on the media itself
   (the container disables it for pan/zoom). */
.media-wrapper img {
  -webkit-touch-callout: default;
  -webkit-user-select: auto;
  user-select: auto;
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
  /* Out of the way until the pointer is over the media. */
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

/* :focus-visible rather than :focus-within: a clicked button keeps focus, which
   would otherwise pin the pill open until something else was clicked. */
.controls.visible,
.controls:hover,
.controls:has(:focus-visible) {
  opacity: 1;
  pointer-events: auto;
}

/* Touch screens have no hover, so keep the controls showing there. */
@media (hover: none) {
  .controls {
    opacity: 1;
    pointer-events: auto;
  }
}

.controls :slotted(button.active) {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.controls :slotted(button svg) {
  display: block;
  width: 1rem;
  height: 1rem;
}

.controls button,
.controls :slotted(button) {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 0.35rem 0.75rem;
  border-radius: 0.25rem;
  font-weight: 500;
}

.controls button:hover,
.controls :slotted(button:hover) {
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

/* Mobile responsive styles */
@media (max-width: 768px) {
  .controls {
    bottom: 0.75rem;
    padding: 0.5rem 0.75rem;
    gap: 0.35rem;
  }

  .controls button {
    padding: 0.5rem 0.75rem;
    min-width: 44px;
    min-height: 44px;
    font-size: 1rem;
  }

  .zoom-level {
    min-width: 3.5rem;
    font-size: 0.8rem;
  }

  .close-button {
    width: 44px;
    height: 44px;
    top: 0.75rem;
    right: 0.75rem;
  }

  .error-url {
    max-width: 250px;
    font-size: 0.7rem;
  }
}

@media (max-width: 480px) {
  .controls {
    left: 0.5rem;
    right: 0.5rem;
    transform: none;
    justify-content: center;
    border-radius: 0.75rem;
  }

  .controls button {
    flex: 1;
    max-width: 60px;
  }

  .close-button {
    top: 0.5rem;
    right: 0.5rem;
  }
}

/* Prevent text selection on touch */
.media-viewer {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
}
</style>
