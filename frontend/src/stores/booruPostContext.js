import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { makeKey } from '../remote/types.js'

// The booru results page a booru post was opened from (the home search's
// section, or its interleaved feed): its posts in grid order, for the booru
// post page's Prev / Next, and which of them the library already has. Empty
// after a reload, when the page is opened straight from its URL.
export const useBooruPostContextStore = defineStore('booruPostContext', () => {
  const posts = shallowRef([])
  const libraryIds = shallowRef(new Map())
  // The home view's import queue while it is alive ({ queue, enqueue }), so
  // an import started on the booru post page joins the Import card's queue.
  const importer = shallowRef(null)

  function setImporter(value) {
    importer.value = value
  }

  function clearImporter(value) {
    if (importer.value === value) importer.value = null
  }

  // `inLibraryPostId(post)` -> the library post id, or null.
  function open(list, inLibraryPostId = () => null) {
    posts.value = [...(list || [])]
    const ids = new Map()
    for (const post of posts.value) {
      const id = Number(inLibraryPostId(post))
      if (id > 0) ids.set(post.key, id)
    }
    libraryIds.value = ids
  }

  function postFor(site, id) {
    const key = makeKey(site, id)
    return posts.value.find((post) => post.key === key) || null
  }

  function neighbours(key) {
    const index = posts.value.findIndex((post) => post.key === key)
    if (index < 0) return { prev: null, next: null }
    return { prev: posts.value[index - 1] || null, next: posts.value[index + 1] || null }
  }

  function libraryIdFor(key) {
    return libraryIds.value.get(key) ?? null
  }

  function markImported(key, postId) {
    const id = Number(postId)
    if (!(id > 0)) return
    const ids = new Map(libraryIds.value)
    ids.set(key, id)
    libraryIds.value = ids
  }

  function clear() {
    posts.value = []
    libraryIds.value = new Map()
  }

  return { posts, importer, open, postFor, neighbours, libraryIdFor, markImported, clear, setImporter, clearImporter }
})
