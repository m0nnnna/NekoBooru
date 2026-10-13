import { computed } from 'vue'
import { useSelection } from './useSelection'
import { isRemoteKey, libraryIdFromKey, libraryKey } from '../remote/types.js'

// Home-view selection across library and booru cards (section 4.3 of
// docs/booru-search-plan.md). Every selected key is a string: 'nekobooru:42'
// for a library post, '<site>:<id>' for a booru post. Library cards emit
// numeric post ids; the on* handlers below are the one place they become keys.
//
// `entries` is a computed list of { key, group, item } in grid order. `group`
// bounds shift-click ranges (a range never crosses sections; a shift-click in
// another section is a plain toggle). `postByKey` resolves selected booru
// posts that are no longer on screen.
export function useMixedSelection(entries, { postByKey = () => null } = {}) {
  const base = useSelection(entries, { keyOf: (entry) => entry.key })
  const { selectMode, selectedIds: selectedKeys, lastSelectedId, hoveredId } = base

  const groupByKey = computed(() => new Map(entries.value.map((entry) => [entry.key, entry.group])))
  const itemByKey = computed(() => new Map(entries.value.map((entry) => [entry.key, entry.item])))

  // What the existing batch tools act on: library posts only.
  const selectedLibraryIds = computed(() => selectedKeys.value.map(libraryIdFromKey).filter((id) => id !== null))
  const selectedLibraryPosts = computed(() => base.selectedItems.value
    .filter((entry) => !isRemoteKey(entry.key))
    .map((entry) => entry.item))

  // What the import card acts on (P4b), in selection order.
  const selectedRemoteKeys = computed(() => selectedKeys.value.filter(isRemoteKey))
  const selectedRemotePosts = computed(() => selectedRemoteKeys.value
    .map((key) => postByKey(key) || itemByKey.value.get(key) || null)
    .filter(Boolean))

  const counts = computed(() => ({
    total: selectedKeys.value.length,
    library: selectedLibraryIds.value.length,
    remote: selectedRemoteKeys.value.length,
  }))

  const selectedKeySet = computed(() => new Set(selectedKeys.value))

  const inspectedLibraryPost = computed(() => {
    const entry = base.inspectedItem.value
    return entry && !isRemoteKey(entry.key) ? entry.item : null
  })
  const inspectedRemotePost = computed(() => {
    const entry = base.inspectedItem.value
    return entry && isRemoteKey(entry.key) ? entry.item : null
  })

  function toggle({ key, shiftKey = false } = {}) {
    if (!key) return
    const last = lastSelectedId.value
    const groups = groupByKey.value
    const sameGroup = last != null && groups.has(key) && groups.get(last) === groups.get(key)
    base.toggleSelect({ id: key, shiftKey: Boolean(shiftKey) && sameGroup })
  }

  function holdSelect(key) {
    if (key) base.enterSelectModeFromHold(key)
  }

  function hover(key) {
    base.hover(key)
  }

  function onLibraryToggle(payload) {
    const id = typeof payload === 'object' ? payload.id : payload
    toggle({ key: libraryKey(id), shiftKey: typeof payload === 'object' && payload.shiftKey })
  }

  function onLibraryHold(id) {
    holdSelect(libraryKey(id))
  }

  function onLibraryHover(id) {
    hover(id == null ? null : libraryKey(id))
  }

  // Drop library keys only (after a delete): booru selections stay.
  function clearLibrarySelection() {
    selectedKeys.value = selectedKeys.value.filter(isRemoteKey)
    if (lastSelectedId.value != null && !isRemoteKey(lastSelectedId.value)) lastSelectedId.value = null
    if (hoveredId.value != null && !isRemoteKey(hoveredId.value)) hoveredId.value = null
  }

  // Swap one key for another in place, e.g. 'danbooru:1' -> 'nekobooru:42'
  // once the post is imported (P4b). A duplicate target just drops `from`.
  function replaceKey(from, to) {
    const keys = [...selectedKeys.value]
    const index = keys.indexOf(from)
    if (index === -1) return false
    if (keys.includes(to)) keys.splice(index, 1)
    else keys.splice(index, 1, to)
    selectedKeys.value = keys
    if (lastSelectedId.value === from) lastSelectedId.value = to
    if (hoveredId.value === from) hoveredId.value = to
    return true
  }

  // The selection object the existing batch tools take: library ids and
  // posts, and a clear that leaves booru selections alone.
  const librarySelection = {
    selectMode,
    selectedIds: selectedLibraryIds,
    selectedItems: selectedLibraryPosts,
    inspectedItem: inspectedLibraryPost,
    clearSelection: clearLibrarySelection,
  }

  return {
    selectMode,
    selectedKeys,
    selectedKeySet,
    selectedLibraryIds,
    selectedLibraryPosts,
    selectedRemoteKeys,
    selectedRemotePosts,
    counts,
    inspectedLibraryPost,
    inspectedRemotePost,
    librarySelection,
    toggle,
    holdSelect,
    hover,
    onLibraryToggle,
    onLibraryHold,
    onLibraryHover,
    replaceKey,
    toggleSelectMode: base.toggleSelectMode,
    selectAllVisible: base.selectAllVisible,
    clearSelection: base.clearSelection,
    clearLibrarySelection,
  }
}
