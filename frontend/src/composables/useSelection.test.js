import { ref } from 'vue'
import { describe, expect, it } from 'vitest'

import { useSelection } from './useSelection'

const posts = () => ref([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])

describe('useSelection', () => {
  it('hold enters select mode, click toggles, and leaving clears the selection', () => {
    const s = useSelection(posts())
    s.enterSelectModeFromHold(2)
    expect(s.selectMode.value).toBe(true)
    expect(s.selectedIds.value).toEqual([2])
    expect(s.inspectedItem.value).toEqual({ id: 2 })

    s.toggleSelect(3)
    s.toggleSelect(2)
    expect(s.selectedIds.value).toEqual([3])

    s.toggleSelectMode()
    expect(s.selectMode.value).toBe(false)
    expect(s.selectedIds.value).toEqual([])
    expect(s.inspectedItem.value).toBe(null)
  })

  it('shift-click selects, then deselects, the visible range', () => {
    const s = useSelection(posts())
    s.toggleSelect({ id: 1, shiftKey: false })
    s.toggleSelect({ id: 3, shiftKey: true })
    expect(s.selectedIds.value).toEqual([1, 2, 3])
    expect(s.selectedItems.value.map((p) => p.id)).toEqual([1, 2, 3])

    s.toggleSelect({ id: 2, shiftKey: true })
    expect(s.selectedIds.value).toEqual([1])
  })

  it('selects the page and keeps keys generic', () => {
    const items = ref([{ source: 'danbooru', id: 7 }, { source: 'library', id: 7 }])
    const s = useSelection(items, { keyOf: (item) => `${item.source}:${item.id}` })
    s.selectAllVisible()
    expect(s.selectedIds.value).toEqual(['danbooru:7', 'library:7'])
    s.hover('library:7')
    expect(s.inspectedItem.value).toEqual({ source: 'library', id: 7 })
    s.clearSelection()
    expect(s.selectedIds.value).toEqual([])
  })
})
