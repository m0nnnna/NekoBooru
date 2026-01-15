import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '../api/client'

export const useTagsStore = defineStore('tags', () => {
  const tags = ref([])
  const categories = ref([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref(null)

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

  async function autocomplete(query) {
    if (!query) return []
    try {
      return await api.autocomplete(query)
    } catch (e) {
      return []
    }
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
    updateTag,
    deleteTag,
  }
})
