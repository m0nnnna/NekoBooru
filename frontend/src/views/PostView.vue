<template>
  <div
    class="post-view"
    :class="{ 'wide-frame': wideFrame, 'sidebar-hidden': sidebarHidden }"
    v-if="post"
  >
    <div class="post-content">
      <div class="media-container">
        <MediaViewer
          ref="mediaViewer"
          :src="post.contentUrl"
          :alt="post.filename"
          :type="mediaType"
          :animate-load="zoomAnimation"
          @close="handleClose"
        >
          <template #controls>
            <button
              type="button"
              class="layout-toggle"
              :class="{ active: zoomAnimation }"
              :title="zoomAnimation ? 'Turn off the zoom-in when a post opens' : 'Turn on the zoom-in when a post opens'"
              :aria-pressed="zoomAnimation"
              @click="toggleZoomAnimation"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="6" />
                <path d="M20 20l-4.5-4.5M11 8v6M8 11h6" />
              </svg>
            </button>
            <button
              type="button"
              class="layout-toggle"
              :class="{ active: wideFrame }"
              :title="wideFrame ? 'Normal width' : 'Widen the frame to the full window'"
              :aria-pressed="wideFrame"
              @click="toggleWideFrame"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4" />
              </svg>
            </button>
            <button
              type="button"
              class="layout-toggle"
              :class="{ active: sidebarHidden }"
              :title="sidebarHidden ? 'Pin the sidebar' : 'Hide the sidebar (hover the right edge to peek)'"
              :aria-pressed="sidebarHidden"
              @click="toggleSidebarHidden"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M15 4v16" />
              </svg>
            </button>
          </template>
        </MediaViewer>
        <button
          v-if="prevId != null"
          type="button"
          class="nav-arrow nav-prev"
          title="Previous post (Left arrow)"
          aria-label="Previous post"
          @click="goToPrev"
        >&#8249;</button>
        <button
          v-if="nextId != null"
          type="button"
          class="nav-arrow nav-next"
          title="Next post (Right arrow)"
          aria-label="Next post"
          @click="goToNext"
        >&#8250;</button>
      </div>
    </div>

    <!-- With the sidebar hidden, this strip on the right edge brings it back on hover. -->
    <div v-if="sidebarHidden" class="sidebar-peek" aria-hidden="true"><span></span></div>
    <aside class="post-sidebar">
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
    </aside>

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
  </div>
  <div v-else-if="loading" class="loading">Loading...</div>
  <div v-else class="error">Post not found</div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api/client'
import { usePostsStore } from '../stores/posts'
import MediaViewer from '../components/MediaViewer.vue'
import TagSidebar from '../components/TagSidebar.vue'
import CommentSection from '../components/CommentSection.vue'
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
  position: relative;
  height: 100%;
  width: 100%;
  border-radius: 0.75rem;
  overflow: hidden;
  background: var(--bg-secondary);
}

.nav-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 64px;
  border: none;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.4);
  color: #fff;
  font-size: 2rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.15s, background 0.15s;
  /* The arrow is a text glyph; keep it from being selected or showing a text caret. */
  user-select: none;
  -webkit-user-select: none;
  caret-color: transparent;
}

.nav-arrow:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.65);
}

.nav-prev {
  left: 0.5rem;
}

.nav-next {
  right: 0.5rem;
}

@media (max-width: 480px) {
  .nav-arrow {
    width: 38px;
    height: 54px;
    font-size: 1.6rem;
  }
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

/* Layout toggles in the viewer's control pill. */
.layout-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sidebar-peek {
  display: none;
}

@media (min-width: 769px) {
  .post-view {
    position: relative;
  }

  /* Hidden sidebar: the frame takes almost the whole row. A slim gutter of its
     own sits beside it (never over it, so the next arrow and the close button
     stay clickable), and hovering that gutter floats the sidebar in. */
  .post-view.sidebar-hidden {
    grid-template-columns: minmax(0, 1fr) 56px;
    gap: 0.5rem;
  }

  .post-view.sidebar-hidden .post-sidebar {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    width: 360px;
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.35);
    opacity: 0;
    transform: translateX(16px);
    pointer-events: none;
    transition: opacity 0.18s ease 0.25s, transform 0.18s ease 0.25s;
  }

  .post-view.sidebar-hidden .sidebar-peek:hover + .post-sidebar,
  .post-view.sidebar-hidden .post-sidebar:hover,
  .post-view.sidebar-hidden .post-sidebar:focus-within {
    opacity: 1;
    transform: none;
    pointer-events: auto;
    transition-delay: 0s;
  }

  .sidebar-peek {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    border: 1px solid transparent;
    border-radius: 0.75rem;
    cursor: w-resize;
    transition: background 0.15s, border-color 0.15s;
  }

  .sidebar-peek:hover {
    background: var(--bg-secondary);
    border-color: var(--border);
  }

  .sidebar-peek span {
    width: 4px;
    height: 64px;
    border-radius: 999px;
    background: var(--accent);
    opacity: 0.4;
    transition: opacity 0.15s;
  }

  .sidebar-peek:hover span {
    opacity: 0.85;
  }
}

@media (max-width: 768px) {
  .layout-toggle {
    display: none;
  }
}

.sidebar-section h3 {
  font-size: 0.75rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 0.75rem;
  font-weight: 600;
}

/* Long tag lists scroll inside their own box instead of stretching the sidebar. */
.tag-scroll-box {
  max-height: min(22rem, 45vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-primary);
  scrollbar-width: thin;
  scrollbar-color: var(--accent) transparent;
}

.tag-scroll-box::-webkit-scrollbar {
  width: 6px;
}

.tag-scroll-box::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--accent);
}

.tag-scroll-box::-webkit-scrollbar-track {
  background: transparent;
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


  .actions {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .actions .btn {
    flex: 1;
    min-width: 100px;
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
<style scoped src="../components/post/postModal.css"></style>
