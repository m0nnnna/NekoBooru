import { ref, computed } from 'vue'

// Edit-mode selection over a list of visible items: hold-to-select, click
// toggles, shift-click ranges, select page, and the hovered/inspected item.
// Keys are whatever `keyOf` returns (library post ids today); nothing here
// assumes they are numbers.
export function useSelection(items, { keyOf = (item) => item.id } = {}) {
  const selectMode = ref(false)
  const selectedIds = ref([])
  const lastSelectedId = ref(null)
  const hoveredId = ref(null)

  // Selected items that are on the current page, in grid order.
  const selectedItems = computed(() => {
    const selected = new Set(selectedIds.value)
    return items.value.filter((item) => selected.has(keyOf(item)))
  })

  // The hovered item, else the most recently selected one.
  const inspectedItem = computed(() => {
    const key = hoveredId.value ?? lastSelectedId.value ?? selectedIds.value[selectedIds.value.length - 1]
    if (key == null) return null
    return items.value.find((item) => keyOf(item) === key) || null
  })

  function toggleSelectMode() {
    selectMode.value = !selectMode.value
    if (!selectMode.value) clearSelection()
  }

  function toggleSelect(payload) {
    const id = typeof payload === 'object' ? payload.id : payload
    const shiftKey = typeof payload === 'object' && payload.shiftKey
    if (shiftKey && lastSelectedId.value != null) {
      toggleRange(lastSelectedId.value, id, !selectedIds.value.includes(id))
      lastSelectedId.value = id
      return
    }
    const idx = selectedIds.value.indexOf(id)
    if (idx === -1) selectedIds.value.push(id)
    else selectedIds.value.splice(idx, 1)
    lastSelectedId.value = id
  }

  function enterSelectModeFromHold(id) {
    if (!selectMode.value) selectMode.value = true
    if (!selectedIds.value.includes(id)) selectedIds.value.push(id)
    lastSelectedId.value = id
    hoveredId.value = id
  }

  function hover(id) {
    hoveredId.value = id
  }

  function rangeIdsBetween(fromId, toId) {
    const fromIndex = items.value.findIndex((item) => keyOf(item) === fromId)
    const toIndex = items.value.findIndex((item) => keyOf(item) === toId)
    if (fromIndex === -1 || toIndex === -1) {
      return [toId]
    }
    const start = Math.min(fromIndex, toIndex)
    const end = Math.max(fromIndex, toIndex)
    return items.value.slice(start, end + 1).map(keyOf)
  }

  function toggleRange(fromId, toId, shouldSelect) {
    const rangeIds = rangeIdsBetween(fromId, toId)
    if (shouldSelect) {
      selectedIds.value = [...new Set([...selectedIds.value, ...rangeIds])]
      return
    }
    const remove = new Set(rangeIds)
    selectedIds.value = selectedIds.value.filter((selectedId) => !remove.has(selectedId))
  }

  function selectAllVisible() {
    const ids = items.value.map(keyOf)
    selectedIds.value = [...new Set([...selectedIds.value, ...ids])]
    if (ids.length) lastSelectedId.value = ids[ids.length - 1]
  }

  function clearSelection() {
    selectedIds.value = []
    lastSelectedId.value = null
    hoveredId.value = null
  }

  return {
    selectMode,
    selectedIds,
    lastSelectedId,
    hoveredId,
    selectedItems,
    inspectedItem,
    toggleSelectMode,
    toggleSelect,
    enterSelectModeFromHold,
    hover,
    selectAllVisible,
    clearSelection,
  }
}
