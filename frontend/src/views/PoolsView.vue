<template>
  <div class="pools-view">
    <div class="header">
      <h1>Pools</h1>
      <button class="btn" @click="showCreateModal = true">Create Pool</button>
    </div>

    <div class="pools-grid">
      <router-link
        v-for="pool in pools"
        :key="pool.id"
        :to="`/pool/${pool.id}`"
        class="pool-card"
      >
        <h3>{{ pool.name }}</h3>
        <p class="pool-desc">{{ pool.description || 'No description' }}</p>
        <div class="pool-meta">
          <span>{{ pool.postCount }} posts</span>
          <span>{{ formatDate(pool.createdAt) }}</span>
        </div>
      </router-link>
    </div>

    <div v-if="pools.length === 0 && !loading" class="empty-state">
      <div class="neko-face">(=^&#xB7;&#x2D8;&#xB7;^=)&#x270B;</div>
      No pools yet. Create one to organize your posts!
    </div>

    <!-- Create Modal -->
    <div v-if="showCreateModal" class="modal-overlay" @click.self="showCreateModal = false">
      <div class="modal">
        <h2>Create Pool</h2>
        <div class="form-group">
          <label>Name</label>
          <input v-model="newPool.name" placeholder="Pool name" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea v-model="newPool.description" placeholder="Description (optional)" rows="3"></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showCreateModal = false">Cancel</button>
          <button class="btn" @click="createPool" :disabled="!newPool.name.trim()">Create</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api/client'

const router = useRouter()

const pools = ref([])
const loading = ref(true)
const showCreateModal = ref(false)
const newPool = ref({ name: '', description: '' })

onMounted(async () => {
  await fetchPools()
})

async function fetchPools() {
  loading.value = true
  try {
    const result = await api.getPools()
    pools.value = result.results
  } catch (e) {
    console.error('Failed to fetch pools:', e)
  } finally {
    loading.value = false
  }
}

async function createPool() {
  if (!newPool.value.name.trim()) return
  try {
    const pool = await api.createPool(newPool.value)
    pools.value.unshift(pool)
    showCreateModal.value = false
    newPool.value = { name: '', description: '' }
    router.push(`/pool/${pool.id}`)
  } catch (e) {
    alert('Failed to create pool: ' + e.message)
  }
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString()
}
</script>

<style scoped>
.pools-view {
  max-width: 1200px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.pools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.pool-card {
  background: var(--bg-secondary);
  border-radius: 0.5rem;
  padding: 1.25rem;
  transition: transform 0.2s, box-shadow 0.2s;
  color: inherit;
}

.pool-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px var(--shadow);
}

.pool-card h3 {
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}

.pool-desc {
  color: var(--text-secondary);
  font-size: 0.875rem;
  margin-bottom: 1rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.pool-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
}

.pool-meta span {
  color: var(--text-secondary);
}

.empty-state {
  text-align: center;
  padding: 3rem;
  color: var(--text-secondary);
}

.neko-face {
  font-size: 2rem;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
  user-select: none;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-primary);
  border-radius: 0.5rem;
  padding: 1.5rem;
  width: 400px;
  max-width: 90vw;
}

.modal h2 {
  margin-bottom: 1rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.25rem;
  font-weight: 500;
}

.form-group input,
.form-group textarea {
  width: 100%;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}
</style>
