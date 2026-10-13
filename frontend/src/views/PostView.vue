<template>
  <PostPageFrame
    v-if="post"
    ref="mediaViewer"
    :src="post.contentUrl"
    :alt="post.filename"
    :type="mediaType"
    :wide-frame="wideFrame"
    :sidebar-hidden="sidebarHidden"
    :zoom-animation="zoomAnimation"
    :has-prev="prevId != null"
    :has-next="nextId != null"
    @close="handleClose"
    @prev="goToPrev"
    @next="goToNext"
    @toggle-zoom-animation="toggleZoomAnimation"
    @toggle-wide-frame="toggleWideFrame"
    @toggle-sidebar-hidden="toggleSidebarHidden"
  >
    <template #sidebar>
      <PostInfoSection :post="post" @set-safety="setSafety" />

      <PostSemanticDescription :analysis="analysis" />

      <div class="sidebar-section">
        <h3>Tags</h3>
        <div :class="{ 'tag-scroll-box': tagListScrolls }">
          <TagSidebar :tags="post.tagDetails || post.tags" />
        </div>
        <button class="btn btn-secondary edit-tags-btn" @click="openTagEditor">
          Edit Tags
        </button>
      </div>

      <div class="sidebar-section actions">
        <button
          class="btn"
          :class="{ 'btn-danger': post.isFavorited }"
          @click="toggleFavorite"
        >
          {{ post.isFavorited ? '&#x1F494; Unfavorite' : '&#x1F43E; Favorite' }}
        </button>
        <button class="btn btn-secondary" @click="showPoolModal = true">
          Add to Pool
        </button>
        <button class="btn btn-danger" @click="deletePost">
          Delete
        </button>
      </div>

      <!-- Per-post tools, one tab each, below the post actions. -->
      <PostToolsSection
        :post="post"
        :media-type="mediaType"
        :layout="layout"
        :auto-tag="autoTag"
        :search="search"
        :optimize="optimize"
      />

      <CommentSection :post-id="post.id" />
    </template>

    <template #default>
      <PostOptimizeDialogs :post="post" :optimize="optimize" />

      <!-- Tag Editor Modal -->
      <PostTagEditorModal :editor="tagEditor" />

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

      <PostAutoTagModals :auto-tag="autoTag" />
    </template>
  </PostPageFrame>
  <div v-else-if="loading" class="post-state post-loading">Loading...</div>
  <div v-else class="post-state">Post not found</div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api/client'
import { usePostsStore } from '../stores/posts'
import TagSidebar from '../components/TagSidebar.vue'
import CommentSection from '../components/CommentSection.vue'
import PostPageFrame from '../components/post/PostPageFrame.vue'
import PostInfoSection from '../components/post/PostInfoSection.vue'
import PostSemanticDescription from '../components/post/PostSemanticDescription.vue'
import PostToolsSection from '../components/post/PostToolsSection.vue'
import PostOptimizeDialogs from '../components/post/PostOptimizeDialogs.vue'
import PostTagEditorModal from '../components/post/PostTagEditorModal.vue'
import PostAutoTagModals from '../components/post/PostAutoTagModals.vue'
import { usePostPageAiAnalysis } from '../composables/usePostPageAiAnalysis'
import { usePostPageAutoTag } from '../composables/usePostPageAutoTag'
import { usePostPageLayout } from '../composables/usePostPageLayout'
import { usePostPageOptimize } from '../composables/usePostPageOptimize'
import { usePostPageSearch } from '../composables/usePostPageSearch'
import { usePostPageTagEditor } from '../composables/usePostPageTagEditor'

const route = useRoute()
const router = useRouter()
const postsStore = usePostsStore()

const post = ref(null)
const prevId = ref(null)
const nextId = ref(null)
const loading = ref(true)
// Short tag lists stay inline; only longer ones get their own scroll box.
const TAG_SCROLL_THRESHOLD = 12
const tagListScrolls = computed(() => (post.value?.tagDetails || post.value?.tags || []).length > TAG_SCROLL_THRESHOLD)
const showPoolModal = ref(false)
const pools = ref([])
const selectedPool = ref('')
const mediaViewer = ref(null)

const mediaType = computed(() => {
  if (!post.value) return 'image'
  const ext = post.value.extension
  if (['.webm', '.mp4'].includes(ext)) return 'video'
  if (ext === '.gif') return 'gif'
  return 'image'
})
const analysis = usePostPageAiAnalysis({ post })
const { postAiAnalyses, loadPostAiAnalysis } = analysis

const tagEditor = usePostPageTagEditor({ post, loadPost })
const { showTagEditor, editedTags, openTagEditor } = tagEditor

const autoTag = usePostPageAutoTag({ post, mediaType, mediaViewer, editedTags, loadPostAiAnalysis })
const {
  showAutoTagModal,
  showAutoProcessModal,
  loadAutoTagControls,
  stopAutoLoadPolling,
  stopAutoTagTimer,
} = autoTag

const search = usePostPageSearch({ post, route, mediaType, mediaViewer })
const {
  similar,
  similarLoaded,
  onlineExactResult,
  onlineSearchBusy,
  onlineSearchMessage,
  refreshExtensionAvailable,
} = search

const optimize = usePostPageOptimize({ post, router, loadPost })
const {
  postOptimizeProfile,
  optimizeStatus,
  optimizePreview,
  optimizePreviewOpen,
  showOptimizeConfirm,
  optimizeJob,
  applyPostOptimizeProfile,
  stopOptimizePolling,
} = optimize

const layout = usePostPageLayout({ autoTag, search, optimize })
const {
  wideFrame,
  sidebarHidden,
  zoomAnimation,
  toggleWideFrame,
  toggleZoomAnimation,
  toggleSidebarHidden,
} = layout

onMounted(async () => {
  await loadPost()
  loadNeighbors()
  window.addEventListener('keydown', onKeydown)
  loadPools()
  loadAutoTagControls()
  refreshExtensionAvailable()
})

onUnmounted(() => {
  stopAutoLoadPolling()
  stopAutoTagTimer()
  stopOptimizePolling()
  window.removeEventListener('keydown', onKeydown)
})

watch(() => route.params.id, async () => {
  await loadPost()
  loadNeighbors()
  similar.value = []
  similarLoaded.value = false
  onlineExactResult.value = null
  onlineSearchMessage.value = ''
  onlineSearchBusy.value = ''
  optimizeStatus.value = ''
  optimizePreview.value = null
  optimizePreviewOpen.value = false
  showOptimizeConfirm.value = false
  optimizeJob.value = null
  stopOptimizePolling()
})

async function loadNeighbors() {
  prevId.value = null
  nextId.value = null
  try {
    const ctx = postsStore.browseContext || {}
    const result = await api.getPostNeighbors(route.params.id, {
      q: ctx.query || '',
      sort: ctx.sort || 'date',
      order: ctx.order || 'desc',
    })
    prevId.value = result.prev
    nextId.value = result.next
  } catch (e) {
    // Navigation is a convenience; ignore failures (e.g. direct deep link).
  }
}

function goToPrev() {
  if (prevId.value != null) router.push(`/post/${prevId.value}`)
}

function goToNext() {
  if (nextId.value != null) router.push(`/post/${nextId.value}`)
}

function onKeydown(e) {
  // Don't hijack arrows while typing or when a modal/overlay is open.
  if (showTagEditor.value || showPoolModal.value || showAutoTagModal.value || showAutoProcessModal.value) return
  const el = e.target
  const tag = el?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'ArrowLeft') {
    if (prevId.value != null) { e.preventDefault(); goToPrev() }
  } else if (e.key === 'ArrowRight') {
    if (nextId.value != null) { e.preventDefault(); goToNext() }
  }
}

async function loadPost() {
  loading.value = true
  try {
    post.value = await api.getPost(route.params.id)
    editedTags.value = [...post.value.tags]
    if (postOptimizeProfile.value !== 'custom') {
      applyPostOptimizeProfile(postOptimizeProfile.value)
    }
    loadPostAiAnalysis()
  } catch (e) {
    post.value = null
    postAiAnalyses.value = []
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
</script>

<style scoped>
.edit-tags-btn {
  margin-top: 0.75rem;
  width: 100%;
}

.pool-select {
  width: 100%;
}

@media (max-width: 480px) {
  .edit-tags-btn {
    font-size: 0.85rem;
  }
}
</style>
<style scoped src="../components/post/postSidebar.css"></style>
<style scoped src="../components/post/postModal.css"></style>
