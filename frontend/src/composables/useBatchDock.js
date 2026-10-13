import { ref, computed, onUnmounted } from 'vue'

// Where the batch edit panel is docked (bottom or right) and its
// user-resized height/width, all remembered in localStorage.

const BATCH_DOCK_KEY = 'nekobooru.batchPanelDock'
const BATCH_BOTTOM_HEIGHT_KEY = 'nekobooru.batchPanelBottomHeight'
const BATCH_RIGHT_WIDTH_KEY = 'nekobooru.batchPanelRightWidth'

function loadBatchDock() {
  try {
    const saved = localStorage.getItem(BATCH_DOCK_KEY)
    return saved === 'right' ? 'right' : 'bottom'
  } catch {
    return 'bottom'
  }
}

function loadBatchSize(key, fallback, min, max) {
  try {
    const saved = Number.parseInt(localStorage.getItem(key) || '', 10)
    if (Number.isFinite(saved)) return Math.max(min, Math.min(max, saved))
  } catch {
    // localStorage unavailable
  }
  return fallback
}

function saveValue(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage unavailable
  }
}

export function useBatchDock() {
  const batchDock = ref(loadBatchDock())
  const batchBottomHeight = ref(loadBatchSize(BATCH_BOTTOM_HEIGHT_KEY, 420, 260, 760))
  const batchRightWidth = ref(loadBatchSize(BATCH_RIGHT_WIDTH_KEY, 440, 320, 760))
  let batchResizeState = null

  const batchPanelStyle = computed(() => (
    batchDock.value === 'right'
      ? { width: `${batchRightWidth.value}px` }
      : { maxHeight: `${batchBottomHeight.value}px` }
  ))

  function setBatchDock(value) {
    batchDock.value = value === 'right' ? 'right' : 'bottom'
    saveValue(BATCH_DOCK_KEY, batchDock.value)
  }

  function startBatchResize(event) {
    batchResizeState = {
      dock: batchDock.value,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: batchRightWidth.value,
      startHeight: batchBottomHeight.value,
    }
    window.addEventListener('pointermove', resizeBatchPanel)
    window.addEventListener('pointerup', stopBatchResize, { once: true })
  }

  function resizeBatchPanel(event) {
    if (!batchResizeState) return
    if (batchResizeState.dock === 'right') {
      const nextWidth = batchResizeState.startWidth + (batchResizeState.startX - event.clientX)
      batchRightWidth.value = Math.max(320, Math.min(Math.round(window.innerWidth * 0.8), nextWidth))
      return
    }
    const nextHeight = batchResizeState.startHeight + (batchResizeState.startY - event.clientY)
    batchBottomHeight.value = Math.max(220, Math.min(Math.round(window.innerHeight * 0.82), nextHeight))
  }

  function stopBatchResize() {
    window.removeEventListener('pointermove', resizeBatchPanel)
    if (batchResizeState?.dock === 'right') {
      saveValue(BATCH_RIGHT_WIDTH_KEY, String(batchRightWidth.value))
    } else if (batchResizeState?.dock === 'bottom') {
      saveValue(BATCH_BOTTOM_HEIGHT_KEY, String(batchBottomHeight.value))
    }
    batchResizeState = null
  }

  onUnmounted(stopBatchResize)

  return {
    batchDock,
    batchPanelStyle,
    setBatchDock,
    startBatchResize,
  }
}
