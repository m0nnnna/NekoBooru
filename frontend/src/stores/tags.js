import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '../api/client'

export const useTagsStore = defineStore('tags', () => {
  const tags = ref([])
  const categories = ref([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref(null)
  // Category and spelling for tags picked from a remote booru suggestion. The
  // library has never seen these, so nothing else can supply them - without
  // this they would be saved as plain general tags and need fixing by hand.
  // Kept in the store rather than threaded through every editor's props, since
  // both TagInput and PostView's raw text editor can be the one that picks.
  const remoteTagMeta = ref({})

  async function fetchTags(params = {}) {
    loading.value = true
    error.value = null
    try {
      const result = await api.getTags(params)
      tags.value = result.results
      total.value = result.total
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function fetchCategories() {
    try {
      categories.value = await api.getCategories()
    } catch (e) {
      error.value = e.message
    }
  }

  async function autocomplete(query, options = {}) {
    if (!query) return []
    try {
      return await api.autocomplete(query, options)
    } catch (e) {
      return []
    }
  }

  function rememberRemoteTag(tag) {
    if (!tag?.remote || !tag.name) return
    remoteTagMeta.value[tag.name] = {
      category: tag.category || 'general',
      displayName: tag.displayName || '',
    }
  }

  // Metadata for the tags actually being saved, in the shape the API takes.
  // General needs no entry: it is already the default.
  function tagMetadataFor(names = []) {
    const categories = {}
    const displayNames = {}
    names.forEach((name) => {
      const meta = remoteTagMeta.value[name]
      if (!meta) return
      if (meta.category && meta.category !== 'general') categories[name] = meta.category
      if (meta.displayName && meta.displayName !== name) displayNames[name] = meta.displayName
    })
    return { categories, displayNames }
  }

  async function updateTag(name, data) {
    try {
      const updated = await api.updateTag(name, data)
      const idx = tags.value.findIndex(t => t.name === name)
      if (idx !== -1) {
        tags.value[idx] = updated
      }
      return updated
    } catch (e) {
      error.value = e.message
      throw e
    }
  }

  async function deleteTag(name) {
    try {
      await api.deleteTag(name)
      tags.value = tags.value.filter(t => t.name !== name)
    } catch (e) {
      error.value = e.message
      throw e
    }
  }

  return {
    tags,
    categories,
    total,
    loading,
    error,
    fetchTags,
    fetchCategories,
    autocomplete,
    remoteTagMeta,
    rememberRemoteTag,
    tagMetadataFor,
    updateTag,
    deleteTag,
  }
})
