<template>
  <div class="post-view" v-if="post">
    <div class="post-content">
      <div class="media-container">
        <MediaViewer
          :src="post.contentUrl"
          :alt="post.filename"
          :type="mediaType"
          @close="handleClose"
        />
      </div>
    </div>

    <aside class="post-sidebar">
      <div class="sidebar-section">
        <h3>Info</h3>
        <dl class="info-list">
          <dt>ID</dt>
          <dd>{{ post.id }}</dd>
          <dt>Size</dt>
          <dd>{{ post.width }} x {{ post.height }}</dd>
          <dt>File size</dt>
          <dd>{{ formatFileSize(post.fileSize) }}</dd>
          <dt>Type</dt>
          <dd>{{ post.extension }}</dd>
          <dt>Uploaded</dt>
          <dd>{{ formatDate(post.createdAt) }}</dd>
          <dt>Rating</dt>
          <dd class="safety-buttons">
            <button
              class="safety-btn safe"
              :class="{ active: post.safety === 'safe' }"
              @click="setSafety('safe')"
              title="Safe"
            ></button>
            <button
              class="safety-btn sketchy"
              :class="{ active: post.safety === 'sketchy' }"
              @click="setSafety('sketchy')"
              title="Sketchy"
            ></button>
            <button
              class="safety-btn unsafe"
              :class="{ active: post.safety === 'unsafe' }"
              @click="setSafety('unsafe')"
              title="Unsafe"
            ></button>
          </dd>
        </dl>
      </div>

      <div class="sidebar-section">
        <h3>Tags</h3>
        <TagList :tags="post.tags" />
        <button class="btn btn-secondary edit-tags-btn" @click="showTagEditor = true">
          Edit Tags
        </button>
      </div>

      <div class="sidebar-section actions">
        <button
          class="btn"
          :class="{ 'btn-danger': post.isFavorited }"
          @click="toggleFavorite"
        >
          {{ post.isFavorited ? 'Unfavorite' : 'Favorite' }}
        </button>
        <button class="btn btn-secondary" @click="showPoolModal = true">
          Add to Pool
        </button>
        <button class="btn btn-danger" @click="deletePost">
          Delete
        </button>
      </div>

      <CommentSection :post-id="post.id" />
    </aside>

    <!-- Tag Editor Modal -->
    <div v-if="showTagEditor" class="modal-overlay" @click.self="showTagEditor = false">
      <div class="modal">
        <h2>Edit Tags</h2>
        <TagInput v-model="editedTags" />
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showTagEditor = false">Cancel</button>
          <button class="btn" @click="saveTags">Save</button>
        </div>
      </div>
    </div>

    <!-- Pool Modal -->
    <div v-if="showPoolModal" class="modal-overlay" @click.self="showPoolModal = false">
      <div class="modal">
        <h2>Add to Pool</h2>
        <select v-model="selectedPool" class="pool-select">
          <option value="">Select a pool...</option>
          <option v-for="pool in pools" :key="pool.id" :value="pool.id">
            {{ pool.name }}
          </option>
        </select>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showPoolModal = false">Cancel</button>
          <button class="btn" @click="addToPool" :disabled="!selectedPool">Add</button>
        </div>
      </div>
    </div>
  </div>
  <div v-else-if="loading" class="loading">Loading...</div>
  <div v-else class="error">Post not found</div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api/client'
import MediaViewer from '../components/MediaViewer.vue'
import TagList from '../components/TagList.vue'
import TagInput from '../components/TagInput.vue'
import CommentSection from '../components/CommentSection.vue'

const route = useRoute()
const router = useRouter()

const post = ref(null)
const loading = ref(true)
const showTagEditor = ref(false)
const showPoolModal = ref(false)
const editedTags = ref([])
const pools = ref([])
const selectedPool = ref('')

const mediaType = computed(() => {
  if (!post.value) return 'image'
  const ext = post.value.extension
  if (['.webm', '.mp4'].includes(ext)) return 'video'
  if (ext === '.gif') return 'gif'
  return 'image'
})

onMounted(async () => {
  await loadPost()
  await loadPools()
})

watch(() => route.params.id, loadPost)

async function loadPost() {
  loading.value = true
  try {
    post.value = await api.getPost(route.params.id)
    editedTags.value = [...post.value.tags]
  } catch (e) {
    post.value = null
  } finally {
    loading.value = false
  }
}

async function loadPools() {
  try {
    const result = await api.getPools()
    pools.value = result.results
  } catch (e) {
    console.error('Failed to load pools:', e)
  }
}

async function toggleFavorite() {
  try {
    const result = await api.toggleFavorite(post.value.id)
    post.value.isFavorited = result.isFavorited
  } catch (e) {
    alert('Failed to toggle favorite: ' + e.message)
  }
}

async function saveTags() {
  try {
    post.value = await api.updatePost(post.value.id, { tags: editedTags.value })
    showTagEditor.value = false
  } catch (e) {
    alert('Failed to save tags: ' + e.message)
  }
}

async function setSafety(safety) {
  if (post.value.safety === safety) return
  const oldSafety = post.value.safety
  post.value.safety = safety
  try {
    await api.updatePost(post.value.id, { safety })
  } catch (e) {
    alert('Failed to update safety: ' + e.message)
    post.value.safety = oldSafety
  }
}

async function addToPool() {
  if (!selectedPool.value) return
  try {
    await api.addPostsToPool(selectedPool.value, [post.value.id])
    showPoolModal.value = false
    selectedPool.value = ''
    alert('Added to pool')
  } catch (e) {
    alert('Failed to add to pool: ' + e.message)
  }
}

async function deletePost() {
  if (!confirm('Are you sure you want to delete this post?')) return
  try {
    await api.deletePost(post.value.id)
    router.back()
  } catch (e) {
    alert('Failed to delete post: ' + e.message)
  }
}

function handleClose() {
  router.back()
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString()
}
</script>

<style scoped>
.post-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 1.5rem;
  height: calc(100vh - 120px);
}

.post-content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.media-container {
  height: 100%;
  width: 100%;
  border-radius: 0.75rem;
  overflow: hidden;
  background: var(--bg-secondary);
}

.post-sidebar {
  background: var(--bg-secondary);
  border-radius: 0.75rem;
  padding: 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  border: 1px solid var(--border);
}

.sidebar-section h3 {
  font-size: 0.75rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 0.75rem;
  font-weight: 600;
}

.info-list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.5rem 1rem;
  font-size: 0.875rem;
}

.info-list dt {
  color: var(--text-secondary);
}

.info-list dd {
  color: var(--text-primary);
  font-weight: 500;
}

.safety-buttons {
  display: flex;
  gap: 0.35rem;
}

.safety-btn {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  opacity: 0.3;
  transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
}

.safety-btn:hover {
  transform: scale(1.1);
}

.safety-btn.active {
  opacity: 1;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.safety-btn.safe {
  background: #4ade80;
}

.safety-btn.sketchy {
  background: #facc15;
}

.safety-btn.unsafe {
  background: #f87171;
}

.edit-tags-btn {
  margin-top: 0.75rem;
  width: 100%;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-primary);
  border-radius: 0.75rem;
  padding: 1.5rem;
  width: 450px;
  max-width: 90vw;
  border: 1px solid var(--border);
  box-shadow: 0 20px 40px var(--shadow);
}

.modal h2 {
  margin-bottom: 1.25rem;
  color: var(--text-primary);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.25rem;
}

.pool-select {
  width: 100%;
}

.loading, .error {
  text-align: center;
  padding: 3rem;
  color: var(--text-secondary);
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

/* Mobile responsive styles */
@media (max-width: 768px) {
  .post-view {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(300px, 60vh) auto;
    height: auto;
    gap: 1rem;
  }

  .post-content {
    min-height: 300px;
  }

  .media-container {
    border-radius: 0.5rem;
  }

  .post-sidebar {
    padding: 1rem;
    gap: 1rem;
    border-radius: 0.5rem;
  }

  .sidebar-section h3 {
    font-size: 0.7rem;
    margin-bottom: 0.5rem;
  }

  .info-list {
    font-size: 0.8rem;
    gap: 0.35rem 0.75rem;
  }

  .safety-btn {
    width: 28px;
    height: 28px;
  }

  .actions {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .actions .btn {
    flex: 1;
    min-width: 100px;
  }

  .modal {
    padding: 1.25rem;
    margin: 1rem;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal h2 {
    font-size: 1.1rem;
    margin-bottom: 1rem;
  }

  .modal-actions {
    flex-direction: column;
    gap: 0.5rem;
  }

  .modal-actions .btn {
    width: 100%;
  }
}

@media (max-width: 480px) {
  .post-view {
    grid-template-rows: minmax(250px, 50vh) auto;
    gap: 0.75rem;
  }

  .post-sidebar {
    padding: 0.875rem;
  }

  .actions .btn {
    font-size: 0.8rem;
    padding: 0.5rem 0.75rem;
  }

  .edit-tags-btn {
    font-size: 0.85rem;
  }
}
</style>
