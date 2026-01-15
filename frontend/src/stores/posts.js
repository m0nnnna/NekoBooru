import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '../api/client'

export const usePostsStore = defineStore('posts', () => {
  const posts = ref([])
  const currentPost = ref(null)
  const total = ref(0)
  const page = ref(1)
  const limit = ref(40)
  const query = ref('')
  const loading = ref(false)
  const error = ref(null)

  const pages = computed(() => Math.ceil(total.value / limit.value))

  async function fetchPosts(params = {}) {
    loading.value = true
    error.value = null
    try {
      const result = await api.getPosts({
        q: query.value,
        page: page.value,
        limit: limit.value,
        ...params,
      })
      posts.value = result.results
      total.value = result.total
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function fetchPost(id) {
    loading.value = true
    error.value = null
    try {
      currentPost.value = await api.getPost(id)
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function updatePost(id, data) {
    try {
      const updated = await api.updatePost(id, data)
      if (currentPost.value?.id === id) {
        currentPost.value = updated
      }
      const idx = posts.value.findIndex(p => p.id === id)
      if (idx !== -1) {
        posts.value[idx] = updated
      }
      return updated
    } catch (e) {
      error.value = e.message
      throw e
    }
  }

  async function deletePost(id) {
    try {
      await api.deletePost(id)
      posts.value = posts.value.filter(p => p.id !== id)
      if (currentPost.value?.id === id) {
        currentPost.value = null
      }
    } catch (e) {
      error.value = e.message
      throw e
    }
  }

  async function toggleFavorite(id) {
    try {
      const result = await api.toggleFavorite(id)
      if (currentPost.value?.id === id) {
        currentPost.value.isFavorited = result.isFavorited
      }
      const post = posts.value.find(p => p.id === id)
      if (post) {
        post.isFavorited = result.isFavorited
      }
      return result.isFavorited
    } catch (e) {
      error.value = e.message
      throw e
    }
  }

  function setQuery(q) {
    query.value = q
    page.value = 1
  }

  function setPage(p) {
    page.value = p
  }

  return {
    posts,
    currentPost,
    total,
    page,
    limit,
    pages,
    query,
    loading,
    error,
    fetchPosts,
    fetchPost,
    updatePost,
    deletePost,
    toggleFavorite,
    setQuery,
    setPage,
  }
})
