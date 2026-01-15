<template>
  <div class="pool-view" v-if="pool">
    <div class="pool-header">
      <div class="pool-info">
        <h1>{{ pool.name }}</h1>
        <p v-if="pool.description" class="description">{{ pool.description }}</p>
        <div class="meta">{{ pool.postCount }} posts</div>
      </div>
      <div class="pool-actions">
        <button class="btn btn-secondary" @click="showEditModal = true">Edit</button>
        <button class="btn btn-danger" @click="deletePool">Delete Pool</button>
      </div>
    </div>

    <div class="posts-grid">
      <div
        v-for="(post, index) in pool.posts"
        :key="post.id"
        class="pool-post"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragover.prevent
        @drop="onDrop(index)"
      >
        <router-link :to="`/post/${post.id}`">
          <img :src="post.thumbUrl" :alt="post.filename" />
        </router-link>
        <button class="remove-btn" @click="removePost(post.id)">&times;</button>
        <div class="post-index">{{ index + 1 }}</div>
      </div>
    </div>

    <div v-if="pool.posts.length === 0" class="empty-state">
      This pool is empty. Add posts from the post view!
    </div>

    <!-- Edit Modal -->
    <div v-if="showEditModal" class="modal-overlay" @click.self="showEditModal = false">
      <div class="modal">
        <h2>Edit Pool</h2>
        <div class="form-group">
          <label>Name</label>
          <input v-model="editData.name" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea v-model="editData.description" rows="3"></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showEditModal = false">Cancel</button>
          <button class="btn" @click="saveEdit">Save</button>
        </div>
      </div>
    </div>
  </div>
  <div v-else-if="loading" class="loading">Loading...</div>
  <div v-else class="error">Pool not found</div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api/client'

const route = useRoute()
const router = useRouter()

const pool = ref(null)
const loading = ref(true)
const showEditModal = ref(false)
const editData = ref({ name: '', description: '' })
const dragIndex = ref(null)

onMounted(async () => {
  await loadPool()
})

watch(() => route.params.id, loadPool)

async function loadPool() {
  loading.value = true
  try {
    pool.value = await api.getPool(route.params.id)
    editData.value = {
      name: pool.value.name,
      description: pool.value.description || '',
    }
  } catch (e) {
    pool.value = null
  } finally {
    loading.value = false
  }
}

async function saveEdit() {
  try {
    const updated = await api.updatePool(pool.value.id, editData.value)
    pool.value.name = updated.name
    pool.value.description = updated.description
    showEditModal.value = false
  } catch (e) {
    alert('Failed to update pool: ' + e.message)
  }
}

async function deletePool() {
  if (!confirm('Are you sure you want to delete this pool?')) return
  try {
    await api.deletePool(pool.value.id)
    router.push('/pools')
  } catch (e) {
    alert('Failed to delete pool: ' + e.message)
  }
}

async function removePost(postId) {
  try {
    await api.removePostFromPool(pool.value.id, postId)
    pool.value.posts = pool.value.posts.filter(p => p.id !== postId)
    pool.value.postCount--
  } catch (e) {
    alert('Failed to remove post: ' + e.message)
  }
}

function onDragStart(index) {
  dragIndex.value = index
}

async function onDrop(targetIndex) {
  if (dragIndex.value === null || dragIndex.value === targetIndex) return

  const posts = [...pool.value.posts]
  const [moved] = posts.splice(dragIndex.value, 1)
  posts.splice(targetIndex, 0, moved)

  pool.value.posts = posts
  dragIndex.value = null

  // Save new order
  try {
    await fetch(`/api/pools/${pool.value.id}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postIds: posts.map(p => p.id) }),
    })
  } catch (e) {
    console.error('Failed to save order:', e)
  }
}
</script>

<style scoped>
.pool-view {
  max-width: 1200px;
}

.pool-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.5rem;
  gap: 2rem;
}

.pool-info h1 {
  margin-bottom: 0.5rem;
}

.description {
  color: var(--text-secondary);
  margin-bottom: 0.5rem;
}

.meta {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.pool-actions {
  display: flex;
  gap: 0.5rem;
}

.posts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.75rem;
}

.pool-post {
  position: relative;
  aspect-ratio: 1;
  background: var(--bg-secondary);
  border-radius: 0.5rem;
  overflow: hidden;
  cursor: grab;
}

.pool-post:active {
  cursor: grabbing;
}

.pool-post img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.remove-btn {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  background: rgba(239, 68, 68, 0.9);
  color: white;
  border: none;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-size: 1rem;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s;
}

.pool-post:hover .remove-btn {
  opacity: 1;
}

.post-index {
  position: absolute;
  bottom: 0.25rem;
  left: 0.25rem;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  padding: 0.125rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.75rem;
}

.empty-state {
  text-align: center;
  padding: 3rem;
  color: var(--text-secondary);
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

.loading, .error {
  text-align: center;
  padding: 3rem;
  color: var(--text-secondary);
}
</style>
