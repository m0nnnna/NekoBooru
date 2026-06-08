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
      @hold-select="enterSelectModeFromHold"
      @hover-post="inspectPost"
    />

    <Pagination
      v-model="page"
      :pages="pages"
      @update:modelValue="onPageChange"
    />

    <section
      v-if="selectMode"
      class="batch-panel"
      :class="`dock-${batchDock}`"
      :style="batchPanelStyle"
    >
      <div
        class="batch-resize-handle"
        :class="`resize-${batchDock}`"
        :title="batchDock === 'right' ? 'Drag to resize panel width' : 'Drag to resize panel height'"
        @pointerdown.prevent="startBatchResize"
      ></div>
      <header class="batch-header">
        <div>
          <strong>{{ selectedIds.length }}</strong> selected
          <span>Hold a post to enter edit mode. Shift-click selects a visible range.</span>
        </div>
        <div class="batch-header-actions">
          <div class="dock-toggle" aria-label="Batch panel dock position">
            <button
              type="button"
              :class="{ active: batchDock === 'bottom' }"
              title="Dock batch tools at the bottom"
              @click="setBatchDock('bottom')"
            >
              Bottom
            </button>
            <button
              type="button"
              :class="{ active: batchDock === 'right' }"
              title="Dock batch tools on the right"
              @click="setBatchDock('right')"
            >
              Right
            </button>
          </div>
          <button type="button" class="link-btn" @click="selectAllVisible">Select page</button>
          <button type="button" class="link-btn" @click="clearSelection" :disabled="!selectedIds.length">
            Clear selection
          </button>
          <button type="button" class="btn btn-secondary" @click="toggleSelectMode">Done</button>
        </div>
      </header>

      <div v-if="batchStatusVisible" class="batch-status" :class="batchStatusKind">
        <div class="batch-status-head">
          <div>
            <strong>{{ batchStatusTitle }}</strong>
            <span>{{ batchStatusDetail }}</span>
          </div>
          <button
            v-if="batchCanCancel"
            type="button"
            class="btn btn-danger"
            :disabled="batchAutoJob?.status === 'cancelling'"
            @click="cancelBatchAutoTag"
          >
            {{ batchAutoJob?.status === 'cancelling' ? 'Cancelling...' : 'Cancel Job' }}
          </button>
        </div>
        <div class="batch-progress">
          <div class="batch-progress-fill" :style="{ width: batchProgressPercent + '%' }"></div>
        </div>
        <div class="batch-stats">
          <span>{{ batchProgressPercent }}%</span>
          <span v-if="batchAutoJob">processed {{ batchAutoJob.processed }} / {{ batchAutoJob.total }}</span>
          <span v-if="batchAutoJob">tagged {{ batchAutoJob.tagged }}</span>
          <span v-if="batchAutoJob">skipped {{ batchAutoJob.skipped }}</span>
          <span v-if="batchAutoJob" :class="{ danger: batchAutoJob.failed }">failed {{ batchAutoJob.failed }}</span>
          <span v-if="!batchAutoJob && batchOperationTotal">selected {{ batchOperationTotal }}</span>
        </div>
        <p v-if="batchAutoJob?.error" class="batch-error">{{ batchAutoJob.error }}</p>
      </div>

      <div class="batch-grid">
        <details class="batch-card ai-batch-card" open>
          <summary>
            <span>AI Tag Selected</span>
            <small>Run a profile or custom model stack on only the selected posts.</small>
          </summary>
          <div class="profile-buttons">
            <button
              v-for="profile in batchAiProfiles"
              :key="profile.id"
              type="button"
              class="profile-button"
              :class="{ active: batchAiProfile === profile.id }"
              :title="profile.help"
              @click="batchAiProfile = profile.id"
            >
              <strong>{{ profile.label }}</strong>
              <span>{{ profile.short }}</span>
            </button>
          </div>
          <div v-if="batchAiProfile === 'custom'" class="batch-ai-custom">
            <label v-for="model in batchModelOptions" :key="model.key" class="batch-check">
              <input type="checkbox" v-model="batchAiSettings[model.key]" />
              <span>
                <strong>{{ model.label }}</strong>
                <small>{{ model.help }}</small>
              </span>
            </label>
            <div class="batch-field-grid">
              <label>
                General threshold
                <input type="number" min="0" max="1" step="0.01" v-model.number="batchAiSettings.generalThreshold" />
              </label>
              <label>
                Character threshold
                <input type="number" min="0" max="1" step="0.01" v-model.number="batchAiSettings.characterThreshold" />
              </label>
              <label>
                Unsafe threshold
                <input type="number" min="0" max="1" step="0.01" v-model.number="batchAiSettings.unsafeThreshold" />
              </label>
              <label>
                Max tags
                <input type="number" min="1" max="100" step="1" v-model.number="batchAiSettings.maxTags" />
              </label>
              <label>
                Video frames
                <input type="number" min="1" max="12" step="1" v-model.number="batchAiSettings.videoMaxFrames" />
              </label>
            </div>
            <label class="batch-check">
              <input type="checkbox" v-model="batchAiSettings.applySafety" />
              <span>
                <strong>Apply safety rating</strong>
                <small>Allow the model to promote selected posts to sketchy or unsafe.</small>
              </span>
            </label>
            <label class="batch-textarea-label">
              Semantic prompt
              <textarea
                v-model="batchAiSettings.semanticPrompt"
                rows="4"
                placeholder="Prompt used when Qwen semantic tags are enabled..."
              ></textarea>
            </label>
          </div>
          <div class="batch-actions-row">
            <button type="button" class="btn btn-secondary" :disabled="!selectedIds.length || busy" @click="runBatchAutoTag(true)">
              Preview Job
            </button>
            <button type="button" class="btn btn-primary" :disabled="!selectedIds.length || busy" @click="runBatchAutoTag(false)">
              Run & Apply
            </button>
          </div>
          <p class="batch-note">
            Preview Job stores suggestions for review. Run & Apply writes tags and safety as each selected post finishes.
          </p>
        </details>

        <details class="batch-card batch-inspector" open>
          <summary>
            <span>Hovered Post Details</span>
            <small>Inspect tags and metadata before chaining another batch operation.</small>
          </summary>
          <div v-if="inspectedPost" class="inspector-body">
            <img :src="inspectedPost.thumbUrl" :alt="inspectedPost.filename" class="inspector-thumb" />
            <div class="inspector-meta">
              <div>
                <strong>#{{ inspectedPost.id }}</strong>
                <span class="safety-pill" :class="inspectedPost.safety">{{ inspectedPost.safety }}</span>
              </div>
              <dl>
                <dt>Type</dt>
                <dd>{{ inspectedPost.extension || 'unknown' }}</dd>
                <dt>Size</dt>
                <dd>{{ inspectedPost.width || '?' }} x {{ inspectedPost.height || '?' }}</dd>
                <dt>File</dt>
                <dd>{{ formatFileSize(inspectedPost.fileSize) }}</dd>
                <template v-if="inspectedPost.source">
                  <dt>Source</dt>
                  <dd :title="inspectedPost.source">{{ truncateText(inspectedPost.source, 54) }}</dd>
                </template>
              </dl>
            </div>
            <div class="inspector-tags">
              <div>
                <strong>{{ inspectedPost.tags?.length || 0 }} tags</strong>
                <small>Hover another post to inspect it.</small>
              </div>
              <div v-if="inspectedPost.tags?.length" class="inspector-tag-list">
                <span v-for="tag in inspectedPost.tags" :key="tag">{{ tag }}</span>
              </div>
              <p v-else class="batch-note">No tags on this post.</p>
            </div>
          </div>
          <p v-else class="batch-note">Hover a post while edit mode is active to inspect it here.</p>
        </details>

        <details class="batch-card" open>
          <summary>
            <span>Tags & Rating</span>
            <small>Add, remove, replace, clear tags, or set safety across selected posts.</small>
          </summary>
          <div class="batch-field-grid compact">
            <label>
              Tag operation
              <select v-model="batchTagMode">
                <option value="add">Add tags</option>
                <option value="remove">Remove tags</option>
                <option value="replace">Replace all tags</option>
                <option value="clear">Clear all tags</option>
              </select>
            </label>
            <label>
              Safety
              <select v-model="batchSafety">
                <option value="">No change</option>
                <option value="safe">Safe</option>
                <option value="sketchy">Sketchy</option>
                <option value="unsafe">Unsafe / NSFW</option>
              </select>
            </label>
          </div>
          <label v-if="batchTagMode !== 'clear'" class="batch-textarea-label">
            Tags
            <textarea
              v-model="batchTagText"
              rows="3"
              placeholder="Comma, space, or newline separated tags..."
            ></textarea>
          </label>
          <div class="batch-actions-row">
            <button type="button" class="btn btn-secondary" :disabled="!selectedIds.length || busy" @click="applyBatchTagUpdate">
              Apply Tag / Rating Changes
            </button>
            <button type="button" class="btn btn-danger" :disabled="!selectedIds.length || busy" @click="clearTagsSelected">
              Clear Tags
            </button>
          </div>
        </details>

        <details class="batch-card">
          <summary>
            <span>Organize & Cleanup</span>
            <small>Pool selected posts or remove bad imports.</small>
          </summary>
          <div class="batch-actions-row">
            <button type="button" class="btn btn-secondary" :disabled="!selectedIds.length || busy" @click="openPoolModal">
              Add to pool
            </button>
            <button type="button" class="btn btn-danger" :disabled="!selectedIds.length || busy" @click="deleteSelected">
              Delete selected
            </button>
          </div>
        </details>
      </div>
    </section>

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
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
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
const BATCH_DOCK_KEY = 'nekobooru.batchPanelDock'
const BATCH_BOTTOM_HEIGHT_KEY = 'nekobooru.batchPanelBottomHeight'
const BATCH_RIGHT_WIDTH_KEY = 'nekobooru.batchPanelRightWidth'
const batchDock = ref(loadBatchDock())
const batchBottomHeight = ref(loadBatchSize(BATCH_BOTTOM_HEIGHT_KEY, 420, 260, 760))
const batchRightWidth = ref(loadBatchSize(BATCH_RIGHT_WIDTH_KEY, 440, 320, 760))
let batchResizeState = null

// --- Multi-select editing mode ---
const selectMode = ref(false)
const selectedIds = ref([])
const lastSelectedId = ref(null)
const hoveredPostId = ref(null)
const busy = ref(false)
const actionMessage = ref('')
const actionMessageKind = ref('success')
let actionMessageTimer = null

const defaultSemanticPrompt = [
  'Return compact JSON only with keys tags, safety, rationale.',
  'Use snake_case tags. Look for higher-level context such as political_edit, meme_edit, amv, music_video, captioned, protest, politician, propaganda, and contextual edit signals only when visually or transcript supported.',
  'Use national_socialism only for clear Nazi/far-right symbols such as a swastika, sonnenrad, or black_sun.',
  'Use communism only for clear communist symbols such as a hammer_and_sickle or communist red star.',
  'If transcript or audio evidence suggests a song or music-driven edit, include music and edit.',
].join(' ')
const batchTagMode = ref('add')
const batchTagText = ref('')
const batchSafety = ref('')
const savedAutoTagSettings = ref({})
const batchAiProfile = ref('default')
const batchAiSettings = ref(defaultBatchAiSettings())
const batchAutoJob = ref(null)
const batchOperation = ref(null)
let batchAutoPollTimer = null

const batchAiProfiles = [
  {
    id: 'default',
    label: 'Default',
    short: 'Saved settings',
    help: 'Uses the model checkboxes, thresholds, safety behavior, and prompt saved in Settings.',
  },
  {
    id: 'anime',
    label: 'Anime',
    short: 'Camie + OCR + audio',
    help: 'Best for anime, manga, illustrations, AMVs, and booru-style art. Uses Camie, OCR, and Whisper for videos.',
  },
  {
    id: 'realistic',
    label: 'Realistic',
    short: 'WD + OCR + audio',
    help: 'Best for real-life videos, screenshots, memes, and edits. Uses WD, OCR, Whisper, and Qwen when your saved semantic defaults enable it.',
  },
  {
    id: 'custom',
    label: 'Custom',
    short: 'Manual stack',
    help: 'Uses the model checkboxes and thresholds shown in this batch panel only.',
  },
]

const batchModelOptions = [
  { key: 'wdEnabled', label: 'WD Tagger', help: 'Broad booru/media tags from images and sampled video frames.' },
  { key: 'characterModelEnabled', label: 'Camie Tagger v2', help: 'Anime character, copyright, artist, and rating tags.' },
  { key: 'ocrEnabled', label: 'TrOCR Printed', help: 'Visible text, captions, subtitle, and meme text extraction.' },
  { key: 'whisperEnabled', label: 'Whisper Small', help: 'Speech, music, AMV/edit, and audio transcript signals for videos.' },
  { key: 'qwenEnabled', label: 'Qwen Semantic', help: 'Higher-level scene, political/edit, propaganda, and contextual tags.' },
]

// Add-to-pool modal
const poolModalOpen = ref(false)
const pools = ref([])
const chosenPoolId = ref('')
const newPoolName = ref('')

const canConfirmPool = computed(() => {
  if (chosenPoolId.value === '__new__') return newPoolName.value.trim().length > 0
  return Boolean(chosenPoolId.value)
})

const batchAutoJobRunning = computed(() =>
  batchAutoJob.value && ['queued', 'running', 'cancelling'].includes(batchAutoJob.value.status)
)

const batchCanCancel = computed(() => Boolean(batchAutoJobRunning.value && batchAutoJob.value?.id))
const batchStatusVisible = computed(() => Boolean(batchAutoJob.value || batchOperation.value))
const batchOperationTotal = computed(() => batchOperation.value?.total || 0)
const batchProgressPercent = computed(() => {
  if (batchAutoJob.value) {
    const total = Number(batchAutoJob.value.total || 0)
    if (!total) return batchAutoJobRunning.value ? 5 : 100
    return Math.max(0, Math.min(100, Math.round((Number(batchAutoJob.value.processed || 0) / total) * 100)))
  }
  if (!batchOperation.value) return 0
  return batchOperation.value.status === 'completed' ? 100 : batchOperation.value.progress
})
const batchStatusKind = computed(() => {
  if (batchAutoJob.value?.status === 'failed' || batchOperation.value?.status === 'failed') return 'error'
  if (batchAutoJob.value && ['completed', 'cancelled'].includes(batchAutoJob.value.status)) return 'success'
  if (batchOperation.value?.status === 'completed') return 'success'
  return 'running'
})
const batchStatusTitle = computed(() => {
  if (batchAutoJob.value) {
    const type = batchAutoJob.value.dryRun ? 'AI Preview Job' : 'AI Run & Apply Job'
    return `${type} #${batchAutoJob.value.id} ${batchAutoJob.value.status}`
  }
  return batchOperation.value?.title || 'Batch operation'
})
const batchStatusDetail = computed(() => {
  if (batchAutoJob.value) {
    if (batchAutoJob.value.status === 'queued') return 'Waiting for the backend worker to start.'
    if (batchAutoJob.value.status === 'running') return 'Analyzing selected posts. Large models can take a while per item.'
    if (batchAutoJob.value.status === 'cancelling') return 'Cancel requested. The current model call may finish first.'
    if (batchAutoJob.value.status === 'completed') return batchAutoJob.value.dryRun
      ? 'Preview suggestions are ready in Settings.'
      : 'Tags and safety updates have been applied.'
    if (batchAutoJob.value.status === 'cancelled') return 'Job was cancelled.'
    if (batchAutoJob.value.status === 'failed') return 'Job failed. Check the error below.'
  }
  return batchOperation.value?.detail || ''
})
const inspectedPost = computed(() => {
  const id = hoveredPostId.value ?? lastSelectedId.value ?? selectedIds.value[selectedIds.value.length - 1]
  if (id == null) return null
  return posts.value.find((post) => post.id === id) || null
})
const batchPanelStyle = computed(() => (
  batchDock.value === 'right'
    ? { width: `${batchRightWidth.value}px` }
    : { maxHeight: `${batchBottomHeight.value}px` }
))

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) clearSelection()
}

function loadBatchDock() {
  try {
    const saved = localStorage.getItem(BATCH_DOCK_KEY)
    return saved === 'right' ? 'right' : 'bottom'
  } catch {
    return 'bottom'
  }
}

function loadBatchSize(key, fallback, min, max) {
  try {
    const saved = Number.parseInt(localStorage.getItem(key) || '', 10)
    if (Number.isFinite(saved)) return Math.max(min, Math.min(max, saved))
  } catch {
    // localStorage unavailable
  }
  return fallback
}

function setBatchDock(value) {
  batchDock.value = value === 'right' ? 'right' : 'bottom'
  try {
    localStorage.setItem(BATCH_DOCK_KEY, batchDock.value)
  } catch {
    // localStorage unavailable
  }
}

function startBatchResize(event) {
  batchResizeState = {
    dock: batchDock.value,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: batchRightWidth.value,
    startHeight: batchBottomHeight.value,
  }
  window.addEventListener('pointermove', resizeBatchPanel)
  window.addEventListener('pointerup', stopBatchResize, { once: true })
}

function resizeBatchPanel(event) {
  if (!batchResizeState) return
  if (batchResizeState.dock === 'right') {
    const nextWidth = batchResizeState.startWidth + (batchResizeState.startX - event.clientX)
    batchRightWidth.value = Math.max(320, Math.min(Math.round(window.innerWidth * 0.8), nextWidth))
    return
  }
  const nextHeight = batchResizeState.startHeight + (batchResizeState.startY - event.clientY)
  batchBottomHeight.value = Math.max(220, Math.min(Math.round(window.innerHeight * 0.82), nextHeight))
}

function stopBatchResize() {
  window.removeEventListener('pointermove', resizeBatchPanel)
  if (batchResizeState?.dock === 'right') {
    try {
      localStorage.setItem(BATCH_RIGHT_WIDTH_KEY, String(batchRightWidth.value))
    } catch {
      // localStorage unavailable
    }
  } else if (batchResizeState?.dock === 'bottom') {
    try {
      localStorage.setItem(BATCH_BOTTOM_HEIGHT_KEY, String(batchBottomHeight.value))
    } catch {
      // localStorage unavailable
    }
  }
  batchResizeState = null
}

function toggleSelect(payload) {
  const id = typeof payload === 'object' ? payload.id : payload
  const shiftKey = typeof payload === 'object' && payload.shiftKey
  if (shiftKey && lastSelectedId.value != null) {
    toggleRange(lastSelectedId.value, id, !selectedIds.value.includes(id))
    lastSelectedId.value = id
    return
  }
  const idx = selectedIds.value.indexOf(id)
  if (idx === -1) selectedIds.value.push(id)
  else selectedIds.value.splice(idx, 1)
  lastSelectedId.value = id
}

function enterSelectModeFromHold(id) {
  if (!selectMode.value) selectMode.value = true
  if (!selectedIds.value.includes(id)) selectedIds.value.push(id)
  lastSelectedId.value = id
  hoveredPostId.value = id
}

function inspectPost(id) {
  hoveredPostId.value = id
}

function rangeIdsBetween(fromId, toId) {
  const fromIndex = posts.value.findIndex((post) => post.id === fromId)
  const toIndex = posts.value.findIndex((post) => post.id === toId)
  if (fromIndex === -1 || toIndex === -1) {
    return [toId]
  }
  const start = Math.min(fromIndex, toIndex)
  const end = Math.max(fromIndex, toIndex)
  return posts.value.slice(start, end + 1).map((post) => post.id)
}

function toggleRange(fromId, toId, shouldSelect) {
  const rangeIds = rangeIdsBetween(fromId, toId)
  if (shouldSelect) {
    selectedIds.value = [...new Set([...selectedIds.value, ...rangeIds])]
    return
  }
  const remove = new Set(rangeIds)
  selectedIds.value = selectedIds.value.filter((selectedId) => !remove.has(selectedId))
}

function selectAllVisible() {
  const ids = posts.value.map((p) => p.id)
  selectedIds.value = [...new Set([...selectedIds.value, ...ids])]
  if (ids.length) lastSelectedId.value = ids[ids.length - 1]
}

function clearSelection() {
  selectedIds.value = []
  lastSelectedId.value = null
  hoveredPostId.value = null
}

function defaultBatchAiSettings() {
  return {
    enabled: true,
    wdEnabled: true,
    characterModelEnabled: false,
    ocrEnabled: false,
    whisperEnabled: false,
    qwenEnabled: false,
    semanticPoliticalEnabled: false,
    generalThreshold: 0.35,
    characterThreshold: 0.45,
    unsafeThreshold: 0.7,
    sketchyThreshold: 0.65,
    maxTags: 40,
    videoMaxFrames: 4,
    applySafety: true,
    semanticPrompt: defaultSemanticPrompt,
  }
}

function parseBatchTags() {
  const seen = new Set()
  return String(batchTagText.value || '')
    .split(/[\s,]+/)
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter((tag) => {
      if (!tag || seen.has(tag)) return false
      seen.add(tag)
      return true
    })
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0)
  if (!value) return 'unknown'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function truncateText(value, maxLength = 60) {
  const text = String(value || '')
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
}

function selectedPostsInCurrentView() {
  const selected = new Set(selectedIds.value)
  return posts.value.filter((post) => selected.has(post.id))
}

function batchTagsForPost(post, tags) {
  const existing = Array.isArray(post.tags) ? post.tags : []
  const incoming = tags || []
  if (batchTagMode.value === 'add') return [...new Set([...existing, ...incoming])]
  if (batchTagMode.value === 'remove') {
    const remove = new Set(incoming)
    return existing.filter((tag) => !remove.has(tag))
  }
  if (batchTagMode.value === 'replace') return incoming
  if (batchTagMode.value === 'clear') return []
  return existing
}

function updateLocalPost(postId, data) {
  const index = posts.value.findIndex((post) => post.id === postId)
  if (index === -1) return
  posts.value[index] = {
    ...posts.value[index],
    ...data,
  }
}

function applyBatchUpdateToLocalPosts({ tags, willChangeTags, willChangeSafety }) {
  for (const post of selectedPostsInCurrentView()) {
    updateLocalPost(post.id, {
      ...(willChangeTags ? { tags: batchTagsForPost(post, tags) } : {}),
      ...(willChangeSafety ? { safety: batchSafety.value } : {}),
    })
  }
}

async function applyBatchUpdateIndividually({ tags, willChangeTags, willChangeSafety }) {
  const selectedPosts = selectedPostsInCurrentView()
  if (selectedPosts.length !== selectedIds.value.length) {
    throw new Error('Some selected posts are no longer visible. Clear selection and select them again.')
  }

  let updated = 0
  for (const post of selectedPosts) {
    const data = {}
    if (willChangeTags) data.tags = batchTagsForPost(post, tags)
    if (willChangeSafety) data.safety = batchSafety.value
    await api.updatePost(post.id, data)
    updateLocalPost(post.id, data)
    updated += 1
    updateBatchOperation(
      `Updated ${updated} / ${selectedPosts.length} selected post(s).`,
      Math.round((updated / selectedPosts.length) * 88),
    )
  }
  return { updated }
}

function selectedMediaSummary() {
  const counts = posts.value.reduce((acc, post) => {
    if (!selectedIds.value.includes(post.id)) return acc
    if (['.mp4', '.webm'].includes(post.extension)) acc.videos += 1
    else if (post.extension === '.gif') acc.gifs += 1
    else acc.images += 1
    return acc
  }, { images: 0, videos: 0, gifs: 0 })
  return counts
}

function batchAiRunSettings() {
  const base = {
    ...(savedAutoTagSettings.value || {}),
    enabled: true,
  }
  if (batchAiProfile.value === 'default') return base
  if (batchAiProfile.value === 'custom') {
    return {
      ...base,
      ...batchAiSettings.value,
      enabled: true,
    }
  }

  const counts = selectedMediaSummary()
  const hasVideo = counts.videos > 0
  if (batchAiProfile.value === 'anime') {
    return {
      ...base,
      enabled: true,
      wdEnabled: false,
      characterModelEnabled: true,
      ocrEnabled: true,
      whisperEnabled: hasVideo,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
      videoMaxFrames: 4,
    }
  }
  if (batchAiProfile.value === 'realistic') {
    const useSemanticQwen = Boolean(base.qwenEnabled || base.semanticPoliticalEnabled)
    return {
      ...base,
      enabled: true,
      wdEnabled: true,
      characterModelEnabled: false,
      ocrEnabled: true,
      whisperEnabled: hasVideo,
      qwenEnabled: useSemanticQwen,
      semanticPoliticalEnabled: useSemanticQwen,
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: hasVideo ? 20 : 18,
      videoMaxFrames: 4,
    }
  }
  return base
}

async function loadBatchAiSettings() {
  try {
    const settings = await api.getAutoTagSettings()
    savedAutoTagSettings.value = { ...settings }
    batchAiSettings.value = {
      ...defaultBatchAiSettings(),
      ...settings,
      enabled: true,
      semanticPrompt: settings.semanticPrompt || defaultSemanticPrompt,
    }
  } catch (e) {
    console.error('Failed to load batch AI settings:', e)
  }
}

function showMessage(text, kind = 'success') {
  actionMessage.value = text
  actionMessageKind.value = kind
  if (actionMessageTimer) clearTimeout(actionMessageTimer)
  actionMessageTimer = setTimeout(() => {
    actionMessage.value = ''
  }, 5000)
}

function beginBatchOperation(title, detail, total = selectedIds.value.length) {
  batchAutoJob.value = null
  stopBatchAutoPolling()
  batchOperation.value = {
    title,
    detail,
    total,
    progress: 12,
    status: 'running',
  }
}

function updateBatchOperation(detail, progress) {
  if (!batchOperation.value) return
  batchOperation.value = {
    ...batchOperation.value,
    detail,
    progress: Math.max(batchOperation.value.progress || 0, progress),
  }
}

function completeBatchOperation(detail, total = batchOperation.value?.total || selectedIds.value.length) {
  if (!batchOperation.value) return
  batchOperation.value = {
    ...batchOperation.value,
    detail,
    total,
    progress: 100,
    status: 'completed',
  }
}

function failBatchOperation(detail) {
  batchOperation.value = {
    ...(batchOperation.value || { title: 'Batch operation', total: selectedIds.value.length }),
    detail,
    status: 'failed',
    progress: Math.max(batchOperation.value?.progress || 0, 100),
  }
}

function stopBatchAutoPolling() {
  if (batchAutoPollTimer) {
    clearInterval(batchAutoPollTimer)
    batchAutoPollTimer = null
  }
}

function startBatchAutoPolling() {
  stopBatchAutoPolling()
  if (!batchAutoJob.value?.id) return
  batchAutoPollTimer = setInterval(refreshBatchAutoJob, 1500)
}

async function refreshBatchAutoJob() {
  if (!batchAutoJob.value?.id) return
  try {
    batchAutoJob.value = await api.getAutoTagJob(batchAutoJob.value.id)
    if (!batchAutoJobRunning.value) {
      stopBatchAutoPolling()
      if (!batchAutoJob.value.dryRun && !selectMode.value) await fetchPosts()
    }
  } catch (e) {
    stopBatchAutoPolling()
    failBatchOperation(`Failed to refresh AI job status: ${e.message}`)
  }
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

async function runBatchAutoTag(dryRun) {
  if (!selectedIds.value.length || busy.value) return
  busy.value = true
  try {
    beginBatchOperation(
      dryRun ? 'Starting AI preview job' : 'Starting AI run & apply job',
      'Sending selected post IDs and model settings to the backend.',
      selectedIds.value.length,
    )
    const job = await api.createAutoTagJob({
      mode: 'selected',
      dryRun,
      postIds: [...selectedIds.value],
      settings: batchAiRunSettings(),
    })
    batchOperation.value = null
    batchAutoJob.value = job
    startBatchAutoPolling()
    showMessage(
      dryRun
        ? `AI preview job started for ${job.total ?? selectedIds.value.length} selected post(s). Review it in Settings.`
        : `AI run & apply job started for ${job.total ?? selectedIds.value.length} selected post(s).`,
    )
  } catch (e) {
    failBatchOperation(e.message)
    showMessage(`AI batch job failed: ${e.message}`, 'error')
  } finally {
    busy.value = false
  }
}

async function cancelBatchAutoTag() {
  if (!batchAutoJob.value?.id) return
  try {
    batchAutoJob.value = await api.cancelAutoTagJob(batchAutoJob.value.id)
    startBatchAutoPolling()
  } catch (e) {
    showMessage(`Cancel failed: ${e.message}`, 'error')
  }
}

async function applyBatchTagUpdate() {
  if (!selectedIds.value.length || busy.value) return
  const tags = parseBatchTags()
  const willChangeTags = batchTagMode.value === 'clear' || tags.length > 0
  const willChangeSafety = Boolean(batchSafety.value)
  if (!willChangeTags && !willChangeSafety) {
    showMessage('Choose tags or a safety rating before applying.', 'error')
    return
  }
  if (batchTagMode.value === 'replace' && !confirm(`Replace all tags on ${selectedIds.value.length} selected post(s)?`)) return
  if (batchTagMode.value === 'clear' && !confirm(`Clear every tag from ${selectedIds.value.length} selected post(s)?`)) return
  busy.value = true
  try {
    beginBatchOperation('Applying tag and rating changes', 'Validating selected posts and requested changes.')
    let result
    try {
      result = await api.bulkUpdatePosts({
        postIds: [...selectedIds.value],
        tagMode: willChangeTags ? batchTagMode.value : null,
        tags,
        safety: batchSafety.value || null,
      })
    } catch (e) {
      if (!String(e.message || '').toLowerCase().includes('not found')) throw e
      updateBatchOperation('Bulk route is not available on this backend yet. Falling back to per-post updates.', 18)
      result = await applyBatchUpdateIndividually({ tags, willChangeTags, willChangeSafety })
    }
    applyBatchUpdateToLocalPosts({ tags, willChangeTags, willChangeSafety })
    if (selectMode.value) {
      updateBatchOperation('Keeping the current edit view and selection for your next operation.', 88)
    } else {
      updateBatchOperation('Refreshing the current page with updated tags and ratings.', 82)
      await fetchPosts()
    }
    completeBatchOperation(
      selectMode.value
        ? `Updated ${result.updated} post(s). Selection is still active for another operation.`
        : `Updated ${result.updated} selected post(s).`,
      result.updated,
    )
    showMessage(`Updated ${result.updated} selected post(s).`)
  } catch (e) {
    failBatchOperation(e.message)
    showMessage(`Batch update failed: ${e.message}`, 'error')
  } finally {
    busy.value = false
  }
}

async function clearTagsSelected() {
  if (!selectedIds.value.length || busy.value) return
  const previousMode = batchTagMode.value
  batchTagMode.value = 'clear'
  await applyBatchTagUpdate()
  batchTagMode.value = previousMode
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
    beginBatchOperation('Adding selected posts to pool', 'Preparing pool selection.', selectedIds.value.length)
    let poolId = chosenPoolId.value
    let poolName = ''
    if (poolId === '__new__') {
      updateBatchOperation('Creating the new pool.', 35)
      const created = await api.createPool({ name: newPoolName.value.trim() })
      poolId = created.id
      poolName = created.name
    } else {
      poolId = Number(poolId)
      poolName = pools.value.find((p) => p.id === poolId)?.name || 'pool'
    }
    updateBatchOperation(`Adding ${selectedIds.value.length} post(s) to "${poolName}".`, 65)
    await api.addPostsToPool(poolId, [...selectedIds.value])
    completeBatchOperation(`Added ${selectedIds.value.length} post(s) to "${poolName}". Selection is still active.`)
    showMessage(`Added ${selectedIds.value.length} post(s) to "${poolName}".`)
    poolModalOpen.value = false
  } catch (e) {
    failBatchOperation(e.message)
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
    beginBatchOperation('Deleting selected posts', 'Soft-deleting selected posts from search results.', selectedIds.value.length)
    const res = await api.bulkDeletePosts([...selectedIds.value])
    if (selectMode.value) {
      updateBatchOperation('Keeping the current edit view. Deleted posts will disappear after you leave or refresh.', 82)
    } else {
      updateBatchOperation('Refreshing the current page after delete.', 82)
      await fetchPosts()
    }
    completeBatchOperation(`Deleted ${res.deleted} selected post(s).`, res.deleted)
    showMessage(`Deleted ${res.deleted} post(s).`)
    clearSelection()
  } catch (e) {
    failBatchOperation(e.message)
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
  loadBatchAiSettings()
  fetchPosts()
})

onUnmounted(() => {
  stopBatchAutoPolling()
  stopBatchResize()
  if (actionMessageTimer) clearTimeout(actionMessageTimer)
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

.batch-panel {
  position: sticky;
  bottom: 0;
  z-index: 20;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  box-shadow: 0 -4px 16px var(--shadow);
  overflow: auto;
  scrollbar-gutter: stable;
}

.batch-panel.dock-bottom {
  max-height: 420px;
}

.batch-panel.dock-right {
  position: fixed;
  top: 6.25rem;
  right: 1rem;
  bottom: 1rem;
  width: 440px;
  max-width: calc(100vw - 2rem);
  max-height: none;
  border-radius: 0.75rem;
  box-shadow: -8px 0 24px var(--shadow);
}

.batch-resize-handle {
  position: absolute;
  z-index: 2;
  opacity: 0.8;
  transition: opacity 0.15s, background 0.15s;
}

.batch-resize-handle:hover {
  opacity: 1;
  background: var(--accent);
}

.resize-bottom {
  top: 0;
  left: 1rem;
  right: 1rem;
  height: 7px;
  cursor: ns-resize;
}

.resize-right {
  top: 1rem;
  bottom: 1rem;
  left: 0;
  width: 7px;
  cursor: ew-resize;
}

.batch-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.batch-header > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  color: var(--text-secondary);
}

.batch-header strong {
  color: var(--text-primary);
}

.batch-header-actions,
.batch-actions-row,
.profile-buttons {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.dock-toggle {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-tertiary);
}

.dock-toggle button {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.45rem 0.65rem;
  font-weight: 700;
}

.dock-toggle button.active {
  background: var(--accent);
  color: white;
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

.batch-grid {
  display: grid;
  grid-template-columns: minmax(320px, 1.2fr) minmax(280px, 1fr);
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.batch-panel.dock-right .batch-header {
  align-items: stretch;
  flex-direction: column;
}

.batch-panel.dock-right .batch-grid {
  grid-template-columns: 1fr;
}

.batch-panel.dock-right .ai-batch-card {
  grid-row: auto;
}

.batch-panel.dock-right .profile-button {
  flex-basis: 46%;
}

.batch-panel.dock-right .inspector-body {
  grid-template-columns: 72px minmax(0, 1fr);
}

.batch-panel.dock-right .inspector-thumb {
  width: 72px;
  height: 72px;
}

.batch-status {
  margin-top: 0.85rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: var(--bg-tertiary);
}

.batch-status.running {
  border-color: rgba(96, 165, 250, 0.55);
}

.batch-status.success {
  border-color: rgba(74, 222, 128, 0.55);
}

.batch-status.error {
  border-color: rgba(248, 113, 113, 0.65);
}

.batch-status-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
}

.batch-status-head > div {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.batch-status-head strong {
  color: var(--text-primary);
}

.batch-status-head span,
.batch-stats {
  color: var(--text-secondary);
}

.batch-progress {
  height: 9px;
  margin-top: 0.75rem;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.batch-progress-fill {
  height: 100%;
  min-width: 4px;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.25s ease;
}

.batch-status.success .batch-progress-fill {
  background: var(--success, #22c55e);
}

.batch-status.error .batch-progress-fill {
  background: var(--coral, #f87171);
}

.batch-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.65rem;
  font-size: 0.85rem;
}

.batch-stats span {
  padding: 0.2rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.12);
}

.batch-stats .danger,
.batch-error {
  color: var(--coral, #f87171);
}

.batch-error {
  margin: 0.65rem 0 0;
}

.batch-card {
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.08);
  padding: 0.8rem;
}

.ai-batch-card {
  grid-row: span 2;
}

.batch-card summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--text-primary);
}

.batch-card summary::-webkit-details-marker {
  display: none;
}

.batch-card summary span::before {
  content: '▸';
  display: inline-block;
  margin-right: 0.35rem;
  transition: transform 0.15s;
}

.batch-card[open] summary span::before {
  transform: rotate(90deg);
}

.batch-card summary small,
.batch-note,
.batch-check small {
  color: var(--text-secondary);
}

.profile-buttons,
.batch-ai-custom,
.batch-field-grid,
.batch-actions-row,
.batch-textarea-label {
  margin-top: 0.75rem;
}

.profile-button {
  flex: 1 1 140px;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  padding: 0.75rem;
  cursor: pointer;
  text-align: left;
}

.profile-button.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.profile-button strong,
.profile-button span,
.batch-check span {
  display: block;
}

.profile-button span {
  color: var(--text-secondary);
  font-size: 0.82rem;
  margin-top: 0.2rem;
}

.batch-ai-custom {
  display: grid;
  gap: 0.6rem;
}

.batch-check {
  display: flex;
  gap: 0.65rem;
  align-items: flex-start;
  padding: 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-tertiary);
}

.batch-check input {
  margin-top: 0.2rem;
}

.batch-field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.65rem;
}

.batch-field-grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.batch-field-grid label,
.batch-textarea-label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  color: var(--text-secondary);
  font-size: 0.86rem;
}

.batch-field-grid input,
.batch-field-grid select,
.batch-textarea-label textarea {
  width: 100%;
  color: var(--text-primary);
}

.batch-textarea-label textarea {
  resize: vertical;
  min-height: 80px;
}

.batch-note {
  margin: 0.65rem 0 0;
  font-size: 0.85rem;
}

.batch-inspector {
  overflow: hidden;
}

.inspector-body {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 0.75rem;
  margin-top: 0.85rem;
}

.inspector-thumb {
  width: 96px;
  height: 96px;
  border-radius: 0.5rem;
  object-fit: cover;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
}

.inspector-meta {
  min-width: 0;
}

.inspector-meta > div:first-child {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.safety-pill {
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
}

.safety-pill.safe {
  background: rgba(74, 222, 128, 0.18);
  color: #86efac;
}

.safety-pill.sketchy {
  background: rgba(250, 204, 21, 0.18);
  color: #fde047;
}

.safety-pill.unsafe {
  background: rgba(248, 113, 113, 0.18);
  color: #fca5a5;
}

.inspector-meta dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.25rem 0.65rem;
  margin: 0;
  font-size: 0.85rem;
}

.inspector-meta dt {
  color: var(--text-secondary);
}

.inspector-meta dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspector-tags {
  grid-column: 1 / -1;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}

.inspector-tags > div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 0.55rem;
}

.inspector-tags > div:first-child strong {
  color: var(--text-primary);
}

.inspector-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  max-height: 132px;
  overflow-y: auto;
  padding-right: 0.25rem;
}

.inspector-tag-list span {
  border: 1px solid var(--accent);
  border-radius: 0.35rem;
  color: var(--accent);
  background: rgba(96, 165, 250, 0.1);
  padding: 0.2rem 0.45rem;
  font-size: 0.8rem;
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

  .batch-header {
    align-items: stretch;
    flex-direction: column;
  }

  .batch-grid {
    grid-template-columns: 1fr;
  }

  .ai-batch-card {
    grid-row: auto;
  }

  .inspector-body {
    grid-template-columns: 72px minmax(0, 1fr);
  }

  .inspector-thumb {
    width: 72px;
    height: 72px;
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
