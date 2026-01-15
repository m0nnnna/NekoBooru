<template>
  <div class="home-view">
    <div class="toolbar">
      <div class="result-count" v-if="!loading">
        {{ total }} posts found
      </div>
      <div class="sort-controls">
        <select v-model="sortBy" @change="fetchPosts">
          <option value="date">Date</option>
          <option value="id">ID</option>
          <option value="size">Size</option>
        </select>
        <select v-model="sortOrder" @change="fetchPosts">
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
      </div>
    </div>

    <PostGrid :posts="posts" :loading="loading" />

    <Pagination
      v-model="page"
      :pages="pages"
      @update:modelValue="onPageChange"
    />
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePostsStore } from '../stores/posts'
import PostGrid from '../components/PostGrid.vue'
import Pagination from '../components/Pagination.vue'

const route = useRoute()
const router = useRouter()
const postsStore = usePostsStore()

const sortBy = ref('date')
const sortOrder = ref('desc')
const page = ref(1)

const posts = ref([])
const total = ref(0)
const pages = ref(0)
const loading = ref(false)

onMounted(() => {
  if (route.query.q) {
    postsStore.setQuery(route.query.q)
  }
  if (route.query.page) {
    page.value = parseInt(route.query.page) || 1
  }
  fetchPosts()
})

watch(
  () => route.query,
  (newQuery) => {
    if (newQuery.q !== postsStore.query) {
      postsStore.setQuery(newQuery.q || '')
    }
    if (newQuery.page) {
      page.value = parseInt(newQuery.page) || 1
    } else {
      page.value = 1
    }
    fetchPosts()
  }
)

async function fetchPosts() {
  loading.value = true
  try {
    const result = await fetch(
      `/api/posts?q=${encodeURIComponent(postsStore.query)}&page=${page.value}&sort=${sortBy.value}&order=${sortOrder.value}`
    ).then(r => r.json())

    posts.value = result.results
    total.value = result.total
    pages.value = result.pages
  } catch (e) {
    console.error('Failed to fetch posts:', e)
  } finally {
    loading.value = false
  }
}

function onPageChange(newPage) {
  page.value = newPage
  router.push({
    query: { ...route.query, page: newPage > 1 ? newPage : undefined }
  })
  fetchPosts()
}
</script>

<style scoped>
.home-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.result-count {
  color: var(--text-secondary);
}

.sort-controls {
  display: flex;
  gap: 0.5rem;
}

.sort-controls select {
  padding: 0.5rem;
}
</style>
