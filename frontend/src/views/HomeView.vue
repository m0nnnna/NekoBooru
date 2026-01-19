<template>
  <div class="home-view">
    <div class="toolbar">
      <div class="result-count">
        <span :class="{ 'loading-fade': loading }">{{ total }} posts found</span>
      </div>
      <div class="toolbar-controls">
        <div class="safety-filter">
          <label
            class="safety-checkbox safe"
            :class="{ active: safetyFilter.safe }"
            title="Safe"
          >
            <input type="checkbox" v-model="safetyFilter.safe" @change="onSafetyChange" />
          </label>
          <label
            class="safety-checkbox sketchy"
            :class="{ active: safetyFilter.sketchy }"
            title="Sketchy"
          >
            <input type="checkbox" v-model="safetyFilter.sketchy" @change="onSafetyChange" />
          </label>
          <label
            class="safety-checkbox unsafe"
            :class="{ active: safetyFilter.unsafe }"
            title="Unsafe"
          >
            <input type="checkbox" v-model="safetyFilter.unsafe" @change="onSafetyChange" />
          </label>
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

// Load safety filter from localStorage or default to all enabled
const defaultSafety = { safe: true, sketchy: true, unsafe: true }
function loadSafetyFilter() {
  try {
    const saved = localStorage.getItem('safetyFilter')
    if (saved) {
      const parsed = JSON.parse(saved)
      // Validate it's an object with the expected properties
      if (typeof parsed === 'object' && 'safe' in parsed) {
        return parsed
      }
    }
  } catch (e) {
    // Invalid JSON, use default
  }
  return { ...defaultSafety }
}
const safetyFilter = ref(loadSafetyFilter())

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
    // Build query with safety filter based on checkboxes
    let query = postsStore.query
    const { safe, sketchy, unsafe } = safetyFilter.value

    // Add exclusions for unchecked ratings
    const exclusions = []
    if (!safe) exclusions.push('-safety:safe')
    if (!sketchy) exclusions.push('-safety:sketchy')
    if (!unsafe) exclusions.push('-safety:unsafe')

    if (exclusions.length > 0) {
      query = query ? `${query} ${exclusions.join(' ')}` : exclusions.join(' ')
    }

    const result = await fetch(
      `/api/posts?q=${encodeURIComponent(query)}&page=${page.value}&sort=${sortBy.value}&order=${sortOrder.value}`
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

function onSafetyChange() {
  localStorage.setItem('safetyFilter', JSON.stringify(safetyFilter.value))
  page.value = 1
  fetchPosts()
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
  flex-wrap: wrap;
  gap: 0.5rem;
}

.result-count {
  color: var(--text-secondary);
  min-width: 120px;
}

.loading-fade {
  opacity: 0.5;
}

.toolbar-controls {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.safety-filter {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.safety-checkbox {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.3;
  transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.safety-checkbox:hover {
  transform: scale(1.1);
}

.safety-checkbox.active {
  opacity: 1;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.safety-checkbox input {
  display: none;
}

.safety-checkbox.safe {
  background: #4ade80;
}

.safety-checkbox.sketchy {
  background: #facc15;
}

.safety-checkbox.unsafe {
  background: #f87171;
}

.sort-controls {
  display: flex;
  gap: 0.5rem;
}

.sort-controls select {
  padding: 0.5rem;
}

/* Mobile responsive styles */
@media (max-width: 768px) {
  .toolbar {
    gap: 0.75rem;
  }

  .toolbar-controls {
    width: 100%;
    justify-content: space-between;
  }

  .result-count {
    font-size: 0.875rem;
    min-width: auto;
  }

  .safety-checkbox {
    width: 32px;
    height: 32px;
    border-radius: 6px;
  }

  .sort-controls select {
    padding: 0.4rem;
    font-size: 0.85rem;
  }
}

@media (max-width: 480px) {
  .home-view {
    gap: 0.75rem;
  }

  .toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .result-count {
    text-align: center;
    font-size: 0.8rem;
  }

  .toolbar-controls {
    flex-direction: column;
    gap: 0.5rem;
  }

  .safety-filter {
    justify-content: center;
    gap: 0.5rem;
  }

  .safety-checkbox {
    width: 36px;
    height: 36px;
  }

  .sort-controls {
    width: 100%;
  }

  .sort-controls select {
    flex: 1;
  }
}
</style>
