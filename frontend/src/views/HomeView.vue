<template>
  <div class="home-view">
    <div class="toolbar">
      <div class="result-count">
        <span :class="{ 'loading-fade': loading }">{{ total }} posts found</span>
      </div>
      <div class="toolbar-controls">
        <button
          type="button"
          class="btn select-toggle"
          :class="selectMode ? 'btn-primary' : 'btn-secondary'"
          @click="toggleSelectMode"
        >
          {{ selectMode ? 'Done' : 'Select' }}
        </button>
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
          <select v-model.number="perPage" @change="onPerPageChange" aria-label="Posts per page">
            <option v-for="option in perPageOptions" :key="option" :value="option">
              {{ option }} per page
            </option>
          </select>
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

    <Pagination
      v-model="page"
      :pages="pages"
      @update:modelValue="onPageChange"
    />

    <PostGrid
      :posts="posts"
      :loading="loading"
      :select-mode="selectMode"
      :selected-ids="selectedIds"
      @toggle="toggleSelect"
    />

    <Pagination
      v-model="page"
      :pages="pages"
      @update:modelValue="onPageChange"
    />

    <!-- Bulk action bar: visible only in select mode -->
    <div v-if="selectMode" class="bulk-bar">
      <div class="bulk-info">
        <strong>{{ selectedIds.length }}</strong> selected
        <button type="button" class="link-btn" @click="selectAllVisible">Select page</button>
        <button type="button" class="link-btn" @click="clearSelection" :disabled="!selectedIds.length">
          Clear
        </button>
      </div>
      <div class="bulk-actions">
        <button type="button" class="btn btn-secondary" :disabled="!selectedIds.length || busy" @click="autotagSelected">
          Autotag
        </button>
        <button type="button" class="btn btn-secondary" :disabled="!selectedIds.length || busy" @click="openPoolModal">
          Add to pool
        </button>
        <button type="button" class="btn btn-danger" :disabled="!selectedIds.length || busy" @click="deleteSelected">
          Delete
        </button>
      </div>
    </div>

    <div v-if="actionMessage" class="action-toast" :class="actionMessageKind">
      {{ actionMessage }}
    </div>

    <!-- Add to pool modal -->
    <div v-if="poolModalOpen" class="modal-overlay" @click.self="poolModalOpen = false">
      <div class="modal">
        <h3>Add {{ selectedIds.length }} post(s) to a pool</h3>
        <div class="pool-list">
          <label v-for="pool in pools" :key="pool.id" class="pool-option">
            <input type="radio" name="pool" :value="pool.id" v-model="chosenPoolId" />
            <span>{{ pool.name }} <small>({{ pool.postCount ?? (pool.posts ? pool.posts.length : 0) }})</small></span>
          </label>
          <label class="pool-option">
            <input type="radio" name="pool" value="__new__" v-model="chosenPoolId" />
            <span>Create new pool</span>
          </label>
          <input
            v-if="chosenPoolId === '__new__'"
            v-model="newPoolName"
            class="new-pool-input"
            type="text"
            placeholder="New pool name"
          />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" @click="poolModalOpen = false" :disabled="busy">Cancel</button>
          <button type="button" class="btn btn-primary" @click="confirmAddToPool" :disabled="busy || !canConfirmPool">
            Add
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePostsStore } from '../stores/posts'
import { api } from '../api/client'
import PostGrid from '../components/PostGrid.vue'
import Pagination from '../components/Pagination.vue'

const route = useRoute()
const router = useRouter()
const postsStore = usePostsStore()

const sortBy = ref('date')
const sortOrder = ref('desc')
const page = ref(1)
const perPageOptions = [24, 42, 60, 100, 200, 500]
const perPage = ref(loadPerPage())

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
const pendingScrollTop = ref(false)

// --- Multi-select editing mode ---
const selectMode = ref(false)
const selectedIds = ref([])
const busy = ref(false)
const actionMessage = ref('')
const actionMessageKind = ref('success')
let actionMessageTimer = null

// Add-to-pool modal
const poolModalOpen = ref(false)
const pools = ref([])
const chosenPoolId = ref('')
const newPoolName = ref('')

const canConfirmPool = computed(() => {
  if (chosenPoolId.value === '__new__') return newPoolName.value.trim().length > 0
  return Boolean(chosenPoolId.value)
})

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) clearSelection()
}

function toggleSelect(id) {
  const idx = selectedIds.value.indexOf(id)
  if (idx === -1) selectedIds.value.push(id)
  else selectedIds.value.splice(idx, 1)
}

function selectAllVisible() {
  const ids = posts.value.map((p) => p.id)
  selectedIds.value = [...new Set([...selectedIds.value, ...ids])]
}

function clearSelection() {
  selectedIds.value = []
}

function showMessage(text, kind = 'success') {
  actionMessage.value = text
  actionMessageKind.value = kind
  if (actionMessageTimer) clearTimeout(actionMessageTimer)
  actionMessageTimer = setTimeout(() => {
    actionMessage.value = ''
  }, 5000)
}

async function autotagSelected() {
  if (!selectedIds.value.length || busy.value) return
  busy.value = true
  try {
    const job = await api.createAutoTagJob({
      mode: 'selected',
      dryRun: false,
      postIds: [...selectedIds.value],
    })
    showMessage(`Auto-tag job started for ${job.total ?? selectedIds.value.length} post(s). It runs in the background.`)
    selectMode.value = false
    clearSelection()
  } catch (e) {
    showMessage(`Auto-tag failed: ${e.message}`, 'error')
  } finally {
    busy.value = false
  }
}

async function openPoolModal() {
  if (!selectedIds.value.length) return
  chosenPoolId.value = ''
  newPoolName.value = ''
  try {
    const res = await api.getPools({ limit: 100 })
    pools.value = res.results || []
  } catch {
    pools.value = []
  }
  poolModalOpen.value = true
}

async function confirmAddToPool() {
  if (!canConfirmPool.value || busy.value) return
  busy.value = true
  try {
    let poolId = chosenPoolId.value
    let poolName = ''
    if (poolId === '__new__') {
      const created = await api.createPool({ name: newPoolName.value.trim() })
      poolId = created.id
      poolName = created.name
    } else {
      poolId = Number(poolId)
      poolName = pools.value.find((p) => p.id === poolId)?.name || 'pool'
    }
    await api.addPostsToPool(poolId, [...selectedIds.value])
    showMessage(`Added ${selectedIds.value.length} post(s) to "${poolName}".`)
    poolModalOpen.value = false
    selectMode.value = false
    clearSelection()
  } catch (e) {
    showMessage(`Add to pool failed: ${e.message}`, 'error')
  } finally {
    busy.value = false
  }
}

async function deleteSelected() {
  if (!selectedIds.value.length || busy.value) return
  if (!confirm(`Delete ${selectedIds.value.length} selected post(s)? They are soft-deleted and hidden from search.`)) {
    return
  }
  busy.value = true
  try {
    const res = await api.bulkDeletePosts([...selectedIds.value])
    showMessage(`Deleted ${res.deleted} post(s).`)
    selectMode.value = false
    clearSelection()
    await fetchPosts()
  } catch (e) {
    showMessage(`Delete failed: ${e.message}`, 'error')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  if (route.query.q) {
    postsStore.setQuery(route.query.q)
  }
  if (route.query.limit) {
    perPage.value = normalizePerPage(route.query.limit)
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
    if (newQuery.limit) {
      perPage.value = normalizePerPage(newQuery.limit)
    }
    fetchPosts()
  }
)

function loadPerPage() {
  try {
    return normalizePerPage(localStorage.getItem('postsPerPage') || 42)
  } catch {
    return 42
  }
}

function normalizePerPage(value) {
  const parsed = Number.parseInt(value, 10)
  return perPageOptions.includes(parsed) ? parsed : 42
}

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

    // Remember exactly what we're showing so the post view can step prev/next
    // through this same filtered, sorted set.
    postsStore.setBrowseContext({ query, sort: sortBy.value, order: sortOrder.value })

    const result = await fetch(
      `/api/posts?q=${encodeURIComponent(query)}&page=${page.value}&limit=${perPage.value}&sort=${sortBy.value}&order=${sortOrder.value}`
    ).then(r => r.json())

    posts.value = result.results
    total.value = result.total
    pages.value = result.pages
  } catch (e) {
    console.error('Failed to fetch posts:', e)
  } finally {
    loading.value = false
    if (pendingScrollTop.value) {
      pendingScrollTop.value = false
      await nextTick()
      scrollToTop()
    }
  }
}

function onSafetyChange() {
  localStorage.setItem('safetyFilter', JSON.stringify(safetyFilter.value))
  page.value = 1
  fetchPosts()
}

function onPerPageChange() {
  perPage.value = normalizePerPage(perPage.value)
  localStorage.setItem('postsPerPage', String(perPage.value))
  page.value = 1
  const query = {
    ...route.query,
    page: undefined,
    limit: perPage.value === 42 ? undefined : perPage.value,
  }
  const routeWillChange =
    String(route.query.page || '') !== String(query.page || '') ||
    String(route.query.limit || '') !== String(query.limit || '')

  requestScrollToTop()
  router.push({ query })
  if (!routeWillChange) fetchPosts()
}

function onPageChange(newPage) {
  page.value = newPage
  requestScrollToTop()
  router.push({
    query: {
      ...route.query,
      page: newPage > 1 ? newPage : undefined,
      limit: perPage.value === 42 ? undefined : perPage.value,
    }
  })
}

function requestScrollToTop() {
  pendingScrollTop.value = true
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'auto' })
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

.select-toggle {
  white-space: nowrap;
}

.bulk-bar {
  position: sticky;
  bottom: 0;
  z-index: 20;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  box-shadow: 0 -4px 16px var(--shadow);
}

.bulk-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-secondary);
}

.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0;
}

.link-btn:disabled {
  color: var(--text-muted);
  cursor: default;
}

.bulk-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.action-toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  padding: 0.75rem 1.25rem;
  border-radius: 0.5rem;
  color: white;
  box-shadow: 0 4px 16px var(--shadow);
  max-width: 90vw;
}

.action-toast.success {
  background: var(--success, #22c55e);
}

.action-toast.error {
  background: var(--coral, #f87171);
}

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 1.5rem;
  width: 100%;
  max-width: 420px;
  max-height: 80vh;
  overflow-y: auto;
}

.modal h3 {
  margin: 0 0 1rem;
}

.pool-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}

.pool-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.pool-option small {
  color: var(--text-muted);
}

.new-pool-input {
  margin-top: 0.25rem;
  padding: 0.5rem;
  width: 100%;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
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
