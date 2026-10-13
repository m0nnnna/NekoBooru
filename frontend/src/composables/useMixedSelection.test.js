import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useMixedSelection } from './useMixedSelection'

const library = [1, 2, 3].map((id) => ({ key: `nekobooru:${id}`, group: 'nekobooru', item: { id } }))
const danbooru = [7, 8].map((id) => ({ key: `danbooru:${id}`, group: 'danbooru', item: { key: `danbooru:${id}`, site: 'danbooru', id: String(id) } }))

function setup() {
  const entries = ref([...library, ...danbooru])
  const offscreen = { key: 'sankaku:q', site: 'sankaku', id: 'q' }
  const selection = useMixedSelection(entries, { postByKey: (key) => (key === offscreen.key ? offscreen : null) })
  return { entries, selection, offscreen }
}

describe('useMixedSelection', () => {
  it('turns library card ids into keys and splits the selection by kind', () => {
    const { selection } = setup()
    selection.onLibraryHold(2)
    expect(selection.selectMode.value).toBe(true)
    selection.toggle({ key: 'danbooru:8' })
    selection.onLibraryToggle({ id: 1, shiftKey: false })
    expect(selection.selectedKeys.value).toEqual(['nekobooru:2', 'danbooru:8', 'nekobooru:1'])
    expect(selection.selectedLibraryIds.value).toEqual([2, 1])
    expect(selection.selectedLibraryPosts.value).toEqual([{ id: 1 }, { id: 2 }])
    expect(selection.selectedRemoteKeys.value).toEqual(['danbooru:8'])
    expect(selection.selectedRemotePosts.value.map((post) => post.key)).toEqual(['danbooru:8'])
    expect(selection.counts.value).toEqual({ total: 3, library: 2, remote: 1 })
    expect(selection.librarySelection.selectedIds.value).toEqual([2, 1])
  })

  it('keeps shift ranges inside one section', () => {
    const { selection } = setup()
    selection.onLibraryToggle({ id: 1 })
    selection.toggle({ key: 'danbooru:8', shiftKey: true })
    expect(selection.selectedKeys.value).toEqual(['nekobooru:1', 'danbooru:8'])
    selection.onLibraryToggle({ id: 3, shiftKey: false })
    selection.onLibraryToggle({ id: 1, shiftKey: true })
    // Shift from 3 back to 1 unselects the range 1..3 (1 was selected).
    expect(selection.selectedKeys.value).toEqual(['danbooru:8'])
    selection.toggle({ key: 'danbooru:7', shiftKey: true })
    expect(selection.selectedKeys.value).toEqual(['danbooru:8', 'danbooru:7'])
  })

  it('reports the inspected post by kind', () => {
    const { selection } = setup()
    selection.onLibraryHover(3)
    expect(selection.inspectedLibraryPost.value).toEqual({ id: 3 })
    expect(selection.inspectedRemotePost.value).toBeNull()
    selection.hover('danbooru:7')
    expect(selection.inspectedLibraryPost.value).toBeNull()
    expect(selection.inspectedRemotePost.value.key).toBe('danbooru:7')
  })

  it('clears library keys only, and swaps an imported key in place', () => {
    const { selection, entries, offscreen } = setup()
    selection.toggle({ key: 'danbooru:7' })
    selection.onLibraryToggle({ id: 2 })
    selection.toggle({ key: 'danbooru:8' })
    // A selected post that scrolled out of the grid still resolves.
    entries.value = [...library]
    selection.selectedKeys.value = [...selection.selectedKeys.value, offscreen.key]
    expect(selection.selectedRemotePosts.value).toEqual([offscreen])

    selection.librarySelection.clearSelection()
    expect(selection.selectedKeys.value).toEqual(['danbooru:7', 'danbooru:8', 'sankaku:q'])

    expect(selection.replaceKey('danbooru:8', 'nekobooru:42')).toBe(true)
    expect(selection.selectedKeys.value).toEqual(['danbooru:7', 'nekobooru:42', 'sankaku:q'])
    expect(selection.replaceKey('danbooru:7', 'nekobooru:42')).toBe(true)
    expect(selection.selectedKeys.value).toEqual(['nekobooru:42', 'sankaku:q'])
    expect(selection.replaceKey('danbooru:1', 'nekobooru:5')).toBe(false)
    expect(selection.selectedLibraryIds.value).toEqual([42])
  })
})
