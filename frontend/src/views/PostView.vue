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
        <button class="btn btn-secondary edit-tags-btn" @click="previewAutoTags" :disabled="autoTagLoading">
          {{ autoTagLoading ? 'AI Tag running...' : 'AI Tag' }}
        </button>
        <div v-if="autoTagLoading" class="ai-inline-status">
          <div class="ai-inline-status-head">
            <strong>{{ autoTagStageTitle }}</strong>
            <span>{{ autoTagRunElapsed }}s</span>
          </div>
          <div class="auto-progress compact">
            <div class="auto-progress-fill" :style="{ width: autoTagOverallProgress + '%' }"></div>
          </div>
          <small>{{ autoTagStageMessage }}</small>
        </div>
        <details class="ai-model-picker" :open="autoModelPickerOpen" @toggle="autoModelPickerOpen = $event.target.open">
          <summary>AI models</summary>
          <div class="ai-model-list">
            <label v-for="model in postModelRows" :key="model.id" class="ai-model-row">
              <input
                type="checkbox"
                v-model="postAutoTagSettings[model.settingKey]"
                :disabled="!model.canToggle"
              />
              <span>
                <strong class="ai-model-name">
                  {{ model.name }}
                  <button
                    type="button"
                    class="ai-info-icon"
                    :data-tooltip="postModelInfoTitle(model)"
                    :aria-label="postModelInfoTitle(model)"
                    @mouseenter="showModelTooltip($event, postModelInfoTitle(model))"
                    @focus="showModelTooltip($event, postModelInfoTitle(model))"
                    @mouseleave="hideModelTooltip"
                    @blur="hideModelTooltip"
                    @click.prevent
                  >i</button>
                </strong>
                <small>
                  {{ model.downloaded ? 'downloaded' : 'not downloaded' }}
                  · {{ model.loaded ? 'loaded' : 'not loaded' }}
                </small>
              </span>
              <button
                type="button"
                class="btn btn-secondary ai-load-btn"
                @click.prevent="model.loaded ? unloadAutoTagWeights(model.id) : loadAutoTagWeights(model.id)"
                :disabled="autoTagLoading || !model.downloaded || !model.runtimeAvailable"
              >
                {{ model.loaded ? 'Unload' : 'Load' }}
              </button>
            </label>
          </div>
        </details>
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

      <CommentSection :post-id="post.id" />
    </aside>

    <Teleport to="body">
      <div
        v-if="modelTooltip.visible"
        class="ai-model-tooltip-layer"
        :style="{ top: modelTooltip.top + 'px', left: modelTooltip.left + 'px' }"
      >
        {{ modelTooltip.text }}
      </div>
    </Teleport>

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

    <div v-if="showAutoTagModal" class="modal-overlay" @click.self="showAutoTagModal = false">
      <div class="modal">
        <h2>AI Tag Preview</h2>
        <div v-if="autoTagSuggestion?.error" class="auto-error">
          {{ autoTagSuggestion.error }}
        </div>
        <div v-else>
          <div class="safety-review">
            <div>
              <strong>Safety rating</strong>
              <small>Suggested by the model. You can override before applying.</small>
            </div>
            <div class="safety-choice-group">
              <button
                v-for="safety in safetyOptions"
                :key="safety.value"
                type="button"
                class="safety-choice"
                :class="[safety.value, { active: autoTagEditedSafety === safety.value }]"
                @click="autoTagEditedSafety = safety.value"
              >
                <span></span>{{ safety.label }}
              </button>
            </div>
          </div>
          <TagInput v-model="autoTagEditedTags" />
          <div v-if="autoTagEvidenceModels.length" class="auto-evidence">
            <h3>Model Evidence</h3>
            <div v-for="(model, index) in autoTagEvidenceModels" :key="index" class="evidence-card">
              <div class="evidence-head">
                <strong>{{ model.model || 'Unknown model' }}</strong>
                <span v-if="model.error" class="evidence-error">{{ model.error }}</span>
              </div>
              <dl>
                <template v-for="item in evidenceRows(model)" :key="item.label">
                  <dt>{{ item.label }}</dt>
                  <dd>{{ item.value }}</dd>
                </template>
              </dl>
            </div>
            <details v-if="autoTagEvidenceRaw" class="raw-evidence">
              <summary>Raw evidence</summary>
              <pre>{{ autoTagEvidenceRaw }}</pre>
            </details>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showAutoTagModal = false">Cancel</button>
          <button v-if="autoTagSuggestion?.error" class="btn" @click="router.push('/settings')">
            Open Settings
          </button>
          <button v-else class="btn" @click="applyAutoTags" :disabled="autoTagLoading || !hasAutoTagChanges">
            Apply
          </button>
        </div>
      </div>
    </div>

    <div v-if="showAutoProcessModal" class="modal-overlay">
      <div class="modal ai-process-modal">
        <h2>{{ autoTagStageTitle }}</h2>
        <p class="auto-summary">
          {{ autoTagStageMessage }}
        </p>
        <div class="auto-progress">
          <div class="auto-progress-fill" :style="{ width: autoTagOverallProgress + '%' }"></div>
        </div>
        <p class="auto-load-meta">
          {{ autoTagOverallProgress }}% · elapsed {{ autoTagRunElapsed }}s · {{ autoTagEstimateLabel }}
        </p>
        <div class="ai-process-steps">
          <div
            v-for="step in autoTagProcessSteps"
            :key="step.key"
            class="ai-process-step"
            :class="step.state"
          >
            <span class="step-dot"></span>
            <div>
              <strong>{{ step.label }}</strong>
              <small>{{ step.detail }}</small>
            </div>
          </div>
        </div>
        <div v-if="selectedAutoTagModelRows.length" class="ai-selected-models">
          <strong>Selected models</strong>
          <ul>
            <li v-for="model in selectedAutoTagModelRows" :key="model.id">
              <span>{{ model.name }}</span>
              <small>
                {{ model.loaded ? 'loaded' : model.downloaded ? 'ready to load' : 'not downloaded' }}
                · {{ model.vramRequirement || 'VRAM varies' }}
              </small>
            </li>
          </ul>
        </div>
        <p v-if="autoLoadJob?.error" class="auto-load-error">
          {{ autoLoadJob.error }}
        </p>
        <p class="auto-load-meta">
          First loads read model weights from disk. Qwen and multi-model previews can take several minutes on CPU or when offloading.
        </p>
      </div>
    </div>
  </div>
  <div v-else-if="loading" class="loading">Loading...</div>
  <div v-else class="error">Post not found</div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
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
const showAutoTagModal = ref(false)
const editedTags = ref([])
const autoTagEditedTags = ref([])
const autoTagEditedSafety = ref('safe')
const autoTagSuggestion = ref(null)
const autoTagLoading = ref(false)
const autoTagStatus = ref(null)
const postAutoTagSettings = ref({})
const autoModelPickerOpen = ref(false)
const showAutoProcessModal = ref(false)
const autoTagStage = ref('idle')
const autoTagStageMessage = ref('')
const autoTagRunStartedAt = ref(0)
const autoTagRunElapsed = ref(0)
const autoLoadJob = ref(null)
const modelTooltip = ref({
  visible: false,
  text: '',
  top: 0,
  left: 0,
})
let autoLoadPollTimer = null
let autoTagTickTimer = null
const pools = ref([])
const selectedPool = ref('')

const mediaType = computed(() => {
  if (!post.value) return 'image'
  const ext = post.value.extension
  if (['.webm', '.mp4'].includes(ext)) return 'video'
  if (ext === '.gif') return 'gif'
  return 'image'
})

const safetyOptions = [
  { value: 'safe', label: 'Safe' },
  { value: 'sketchy', label: 'Sketchy' },
  { value: 'unsafe', label: 'Unsafe / NSFW' },
]

const autoTagEvidenceRaw = computed(() => {
  if (!autoTagSuggestion.value?.evidence) return ''
  return JSON.stringify(autoTagSuggestion.value.evidence, null, 2)
})

const autoTagEvidenceModels = computed(() => {
  const evidence = autoTagSuggestion.value?.evidence
  if (!evidence) return []
  if (Array.isArray(evidence.models)) return evidence.models
  return [{ model: autoTagSuggestion.value?.model || 'Auto tagger', evidence }]
})

const hasAutoTagChanges = computed(() => {
  if (!post.value || !autoTagSuggestion.value) return false
  const before = [...post.value.tags].sort().join('\n')
  const after = [...autoTagEditedTags.value].sort().join('\n')
  return before !== after || autoTagEditedSafety.value !== post.value.safety
})

const autoLoadProgress = computed(() => Math.max(0, Math.min(100, Number(autoLoadJob.value?.progress || 0))))
const autoLoadEstimate = computed(() => Number(autoLoadJob.value?.estimatedSeconds || 20))
const selectedAutoTagModelRows = computed(() => enabledModelRows())
const autoTagStageTitle = computed(() => ({
  checking: 'Checking AI Tagging',
  loading: 'Loading AI Model Weights',
  analyzing: 'Analyzing Media',
  ready: 'AI Tag Preview Ready',
  failed: 'AI Tagging Failed',
}[autoTagStage.value] || 'Preparing AI Tagging'))
const autoTagOverallProgress = computed(() => {
  if (autoTagStage.value === 'checking') return 8
  if (autoTagStage.value === 'loading') return Math.max(12, Math.min(72, 12 + Math.round(autoLoadProgress.value * 0.6)))
  if (autoTagStage.value === 'analyzing') {
    const expected = currentPreviewEstimateSeconds()
    const elapsedProgress = expected ? Math.min(24, Math.round((autoTagRunElapsed.value / expected) * 24)) : 8
    return Math.min(96, 72 + elapsedProgress)
  }
  if (autoTagStage.value === 'ready') return 100
  if (autoTagStage.value === 'failed') return Math.max(8, autoLoadProgress.value)
  return 0
})
const autoTagEstimateLabel = computed(() => {
  if (autoTagStage.value === 'loading') return `model estimate ${autoLoadEstimate.value}s`
  if (autoTagStage.value === 'analyzing') return `analysis usually ${currentPreviewEstimateSeconds()}s+`
  return 'starting'
})
const autoTagProcessSteps = computed(() => {
  const selected = selectedAutoTagModelRows.value.length
  return [
    {
      key: 'check',
      label: 'Check settings',
      detail: 'Validating enabled models, downloads, and runtime packages.',
      state: stepState(['loading', 'analyzing', 'ready'], 'checking'),
    },
    {
      key: 'load',
      label: 'Load model weights',
      detail: autoLoadJob.value?.message || `${selected || 'Selected'} model${selected === 1 ? '' : 's'} will be loaded if needed.`,
      state: stepState(['analyzing', 'ready'], 'loading'),
    },
    {
      key: 'analyze',
      label: mediaType.value === 'video' ? 'Sample frames and analyze video' : 'Analyze image',
      detail: analysisDetail(),
      state: stepState(['ready'], 'analyzing'),
    },
  ]
})
const postModelRows = computed(() => {
  const models = autoTagStatus.value?.models || []
  return models.map((model) => ({
    ...model,
    settingKey: modelSettingKey(model.id),
    canToggle: true,
  }))
})

onMounted(async () => {
  await loadPost()
  await loadPools()
  await loadAutoTagControls()
})

onUnmounted(() => {
  stopAutoLoadPolling()
  stopAutoTagTimer()
})

watch(() => route.params.id, loadPost)

function modelSettingKey(id) {
  return {
    wd: 'wdEnabled',
    camie: 'characterModelEnabled',
    ocr: 'ocrEnabled',
    whisper: 'whisperEnabled',
    qwen: 'qwenEnabled',
  }[id] || `${id}Enabled`
}

function modelPipelineDescription(id) {
  return {
    wd: 'Runs on images and sampled video frames. Best baseline for visual library tags.',
    camie: 'Adds anime characters, copyright/source tags, artist tags, and rating evidence.',
    ocr: 'Reads visible captions, subtitles, and meme text from representative frames.',
    whisper: 'Extracts speech from video audio for AMVs, edits, narration, and spoken context.',
    qwen: 'Uses image plus OCR/transcript context for higher-level edit and scene meaning.',
  }[id] || 'Use this model in the per-post auto-tagging pipeline.'
}

function postModelInfoTitle(model) {
  return [
    model.name,
    model.purpose,
    modelPipelineDescription(model.id),
    `Download size: ${model.downloadSize || 'Unknown'}`,
    `VRAM: ${model.vramRequirement || 'Unknown'}`,
    `Runtime: ${model.runtimeAvailable ? 'ready' : 'missing'}`,
    `Memory: ${model.loaded ? 'loaded' : 'not loaded'}`,
  ].join('\n')
}

function showModelTooltip(event, text) {
  const rect = event.currentTarget.getBoundingClientRect()
  const tooltipWidth = 300
  const gap = 10
  modelTooltip.value = {
    visible: true,
    text,
    top: Math.max(12, rect.top - 8),
    left: Math.max(12, Math.min(window.innerWidth - tooltipWidth - 12, rect.left - tooltipWidth - gap)),
  }
}

function hideModelTooltip() {
  modelTooltip.value.visible = false
}

function evidenceRows(model) {
  const evidence = model.evidence || {}
  const rows = []
  if (evidence.kind) rows.push({ label: 'Source', value: evidence.kind })
  if (Array.isArray(evidence.topTags) && evidence.topTags.length) {
    rows.push({ label: 'Top tags', value: evidence.topTags.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (Array.isArray(evidence.topCharacters) && evidence.topCharacters.length) {
    rows.push({ label: 'Characters', value: evidence.topCharacters.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (Array.isArray(evidence.topCopyrights) && evidence.topCopyrights.length) {
    rows.push({ label: 'Copyrights', value: evidence.topCopyrights.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (evidence.rating && Object.keys(evidence.rating).length) {
    rows.push({ label: 'Rating evidence', value: formatScoreMap(evidence.rating) })
  }
  if (evidence.text) rows.push({ label: 'OCR text', value: evidence.text })
  if (evidence.transcript) rows.push({ label: 'Transcript', value: evidence.transcript })
  if (evidence.parsed?.tags?.length) rows.push({ label: 'Semantic tags', value: evidence.parsed.tags.join(', ') })
  if (evidence.parsed?.safety) rows.push({ label: 'Semantic safety', value: evidence.parsed.safety })
  if (evidence.raw && !rows.some((row) => row.label === 'Semantic tags')) {
    rows.push({ label: 'Model output', value: String(evidence.raw).slice(0, 500) })
  }
  if (!rows.length && model.error) rows.push({ label: 'Status', value: model.error })
  if (!rows.length) rows.push({ label: 'Details', value: 'No structured evidence returned.' })
  return rows
}

function formatTagScore(item) {
  const tag = item.tag || item.name || String(item)
  const confidence = Number(item.confidence ?? item.score)
  if (!Number.isFinite(confidence)) return tag
  return `${tag} ${Math.round(confidence * 100)}%`
}

function formatScoreMap(map) {
  return Object.entries(map)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6)
    .map(([key, value]) => `${key} ${Math.round(Number(value) * 100)}%`)
    .join(', ')
}

async function loadAutoTagControls() {
  try {
    const [settingsResult, statusResult] = await Promise.all([
      api.getAutoTagSettings(),
      api.getAutoTagStatus(),
    ])
    postAutoTagSettings.value = {
      ...settingsResult,
      wdEnabled: settingsResult.wdEnabled !== false,
    }
    autoTagStatus.value = statusResult
  } catch (e) {
    console.error('Failed to load AI tag controls:', e)
  }
}

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

async function previewAutoTags() {
  autoTagLoading.value = true
  beginAutoTagProcess('checking', 'Checking settings, selected models, and local runtime packages.')
  try {
    autoTagStatus.value = await api.getAutoTagStatus()
    if (!autoTagStatus.value.enabled) {
      autoTagSuggestion.value = {
        error: 'AI tagging is disabled. Enable Auto Tagging in Settings first.',
        suggestedTags: post.value.tags,
        suggestedSafety: post.value.safety,
      }
      autoTagEditedTags.value = [...post.value.tags]
      autoTagEditedSafety.value = post.value.safety || 'safe'
      showAutoTagModal.value = true
      return
    }

    const missingDeps = Object.entries(autoTagStatus.value.dependencies || {})
      .filter(([, available]) => !available)
      .map(([name]) => name)
    if (missingDeps.length > 0) {
      autoTagSuggestion.value = {
        error: `AI tagging is missing optional backend packages: ${missingDeps.join(', ')}. Install backend/requirements-tagger.txt and restart the backend.`,
        suggestedTags: post.value.tags,
        suggestedSafety: post.value.safety,
      }
      autoTagEditedTags.value = [...post.value.tags]
      autoTagEditedSafety.value = post.value.safety || 'safe'
      showAutoTagModal.value = true
      return
    }

    await loadEnabledAutoTagModels()

    beginAutoTagStage('analyzing', analysisDetail())
    autoTagSuggestion.value = await api.previewAutoTags(post.value.id, {
      settings: autoTagRunSettings(),
    })
    autoTagEditedTags.value = [...(autoTagSuggestion.value.suggestedTags || post.value.tags)]
    autoTagEditedSafety.value = autoTagSuggestion.value.suggestedSafety || post.value.safety || 'safe'
    beginAutoTagStage('ready', 'Preview is ready. Review the suggested tags and safety rating before applying.')
    showAutoTagModal.value = true
  } catch (e) {
    beginAutoTagStage('failed', e.message)
    alert(`Failed to preview AI tags: ${e.message}\n\nLarge Qwen runs can take a while. If the backend is still healthy, try again after the model finishes loading.`)
  } finally {
    autoTagLoading.value = false
    showAutoProcessModal.value = false
    stopAutoTagTimer()
  }
}

function autoTagRunSettings() {
  return {
    ...postAutoTagSettings.value,
    enabled: true,
  }
}

function enabledModelRows() {
  return postModelRows.value.filter((model) => Boolean(postAutoTagSettings.value[model.settingKey]))
}

async function loadEnabledAutoTagModels() {
  for (const model of enabledModelRows()) {
    if (!model.downloaded || !model.runtimeAvailable || model.loaded) continue
    await loadAutoTagWeights(model.id, { keepOpen: true })
  }
}

async function loadAutoTagWeights(modelId = 'wd', options = {}) {
  const keepOpen = Boolean(options.keepOpen)
  const message = `Starting ${modelLabel(modelId)} model load.`
  if (showAutoProcessModal.value) {
    beginAutoTagStage('loading', message)
  } else {
    beginAutoTagProcess('loading', message)
  }
  try {
    autoLoadJob.value = await api.loadAutoTagModelById(modelId)
    if (autoLoadJob.value?.message) autoTagStageMessage.value = autoLoadJob.value.message
    await new Promise((resolve, reject) => {
      autoLoadPollTimer = setInterval(async () => {
        try {
          autoLoadJob.value = await api.getAutoTagModelLoadJob()
          if (autoLoadJob.value?.message) {
            autoTagStageMessage.value = autoLoadJob.value.message
          }
          if (!autoLoadJob.value || !['queued', 'running'].includes(autoLoadJob.value.status)) {
            stopAutoLoadPolling()
            if (autoLoadJob.value?.status === 'failed') {
              reject(new Error(autoLoadJob.value.error || 'Model load failed'))
              return
            }
            resolve()
          }
        } catch (e) {
          stopAutoLoadPolling()
          reject(e)
        }
      }, 700)
    })
    autoTagStatus.value = await api.getAutoTagStatus()
  } finally {
    if (!keepOpen) {
      showAutoProcessModal.value = false
      stopAutoTagTimer()
    }
  }
}

async function unloadAutoTagWeights(modelId) {
  autoTagLoading.value = true
  try {
    const result = await api.unloadAutoTagModelById(modelId)
    if (autoTagStatus.value) {
      autoTagStatus.value.models = result.models || autoTagStatus.value.models
      if (modelId === 'wd') autoTagStatus.value.modelLoaded = false
    } else {
      autoTagStatus.value = await api.getAutoTagStatus()
    }
  } catch (e) {
    alert('Failed to unload model: ' + e.message)
  } finally {
    autoTagLoading.value = false
  }
}

function stopAutoLoadPolling() {
  if (autoLoadPollTimer) clearInterval(autoLoadPollTimer)
  autoLoadPollTimer = null
}

function beginAutoTagProcess(stage, message) {
  showAutoProcessModal.value = true
  autoLoadJob.value = null
  autoTagRunStartedAt.value = Date.now()
  autoTagRunElapsed.value = 0
  beginAutoTagStage(stage, message)
  stopAutoTagTimer()
  autoTagTickTimer = setInterval(() => {
    autoTagRunElapsed.value = Math.max(0, Math.round((Date.now() - autoTagRunStartedAt.value) / 1000))
  }, 500)
}

function beginAutoTagStage(stage, message) {
  autoTagStage.value = stage
  autoTagStageMessage.value = message || ''
  if (stage !== 'loading') {
    autoLoadJob.value = null
  }
}

function stopAutoTagTimer() {
  if (autoTagTickTimer) clearInterval(autoTagTickTimer)
  autoTagTickTimer = null
}

function stepState(completedStages, activeStage) {
  if (completedStages.includes(autoTagStage.value)) return 'completed'
  if (autoTagStage.value === activeStage) return 'active'
  if (autoTagStage.value === 'failed') return 'failed'
  return 'pending'
}

function modelLabel(modelId) {
  return postModelRows.value.find((model) => model.id === modelId)?.name || 'AI'
}

function currentPreviewEstimateSeconds() {
  const ids = selectedAutoTagModelRows.value.map((model) => model.id)
  let estimate = mediaType.value === 'video' ? 45 : 20
  if (ids.includes('qwen')) estimate += mediaType.value === 'video' ? 150 : 90
  if (ids.includes('whisper')) estimate += 45
  if (ids.includes('ocr')) estimate += 20
  if (ids.includes('camie')) estimate += 20
  return estimate
}

function analysisDetail() {
  const names = selectedAutoTagModelRows.value.map((model) => model.name)
  const joined = names.length ? names.join(', ') : 'selected models'
  if (mediaType.value === 'video') {
    return `Sampling frames and running ${joined}. Qwen or audio transcript passes may run longer.`
  }
  return `Running ${joined} against this image and preparing tag evidence.`
}

async function applyAutoTags() {
  autoTagLoading.value = true
  try {
    post.value = await api.applyAutoTags(post.value.id, {
      tags: autoTagEditedTags.value,
      safety: autoTagEditedSafety.value || post.value.safety,
      categories: autoTagSuggestion.value?.categories || {},
      settings: autoTagRunSettings(),
    })
    editedTags.value = [...post.value.tags]
    showAutoTagModal.value = false
  } catch (e) {
    alert('Failed to apply AI tags: ' + e.message)
  } finally {
    autoTagLoading.value = false
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

.ai-inline-status {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.ai-inline-status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.45rem;
  color: var(--text-primary);
  font-size: 0.82rem;
}

.ai-inline-status-head span,
.ai-inline-status small {
  color: var(--text-secondary);
  font-size: 0.74rem;
}

.ai-model-picker {
  margin-top: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.ai-model-picker summary {
  cursor: pointer;
  padding: 0.65rem 0.75rem;
  color: var(--text-primary);
  font-weight: 600;
  font-size: 0.9rem;
}

.ai-model-list {
  display: grid;
  gap: 0.5rem;
  padding: 0 0.75rem 0.75rem;
}

.ai-model-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.ai-model-row small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.72rem;
  margin-top: 0.1rem;
}

.ai-model-name {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.ai-info-icon {
  position: relative;
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: help;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 15px;
}

.ai-info-icon:hover,
.ai-info-icon:focus-visible {
  color: var(--text-primary);
  border-color: var(--accent);
}

.ai-load-btn {
  padding: 0.35rem 0.55rem;
  font-size: 0.78rem;
  min-width: 58px;
}

.ai-model-tooltip-layer {
  position: fixed;
  z-index: 5000;
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
  font-size: 0.76rem;
  font-weight: 500;
  line-height: 1.4;
  text-align: left;
  white-space: pre-line;
  pointer-events: none;
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

.auto-summary {
  margin-bottom: 0.75rem;
  color: var(--text-secondary);
}

.ai-process-modal {
  width: 520px;
}

.ai-process-steps {
  display: grid;
  gap: 0.65rem;
  margin: 1rem 0;
}

.ai-process-step {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.7rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.ai-process-step strong {
  display: block;
  color: var(--text-primary);
  font-size: 0.86rem;
  margin-bottom: 0.15rem;
}

.ai-process-step small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.step-dot {
  width: 11px;
  height: 11px;
  margin-top: 0.2rem;
  border-radius: 999px;
  background: var(--border);
  box-shadow: 0 0 0 4px rgba(148, 163, 184, 0.08);
}

.ai-process-step.active .step-dot {
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.ai-process-step.completed .step-dot {
  background: #4ade80;
  box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.13);
}

.ai-process-step.failed .step-dot {
  background: #f87171;
  box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.14);
}

.ai-selected-models {
  padding: 0.8rem;
  margin-top: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.ai-selected-models > strong {
  display: block;
  margin-bottom: 0.55rem;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.ai-selected-models ul {
  display: grid;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-selected-models li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  color: var(--text-primary);
  font-size: 0.8rem;
}

.ai-selected-models small {
  color: var(--text-secondary);
  text-align: right;
}

.safety-review {
  display: grid;
  gap: 0.75rem;
  padding: 0.85rem;
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.safety-review strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 0.15rem;
}

.safety-review small {
  color: var(--text-secondary);
}

.safety-choice-group {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.safety-choice {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 38px;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-weight: 600;
  font-size: 0.82rem;
}

.safety-choice span {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.safety-choice.safe span {
  background: #4ade80;
}

.safety-choice.sketchy span {
  background: #facc15;
}

.safety-choice.unsafe span {
  background: #f87171;
}

.safety-choice.active {
  color: var(--text-primary);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.auto-error {
  padding: 0.75rem;
  background: var(--coral-soft);
  border: 1px solid var(--coral);
  border-radius: 0.5rem;
  color: var(--text-primary);
}

.auto-evidence {
  margin-top: 1rem;
  max-height: 240px;
  overflow: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem;
}

.auto-evidence h3 {
  margin: 0 0 0.65rem;
  color: var(--text-primary);
  font-size: 0.9rem;
}

.evidence-card {
  padding: 0.75rem;
  margin-bottom: 0.6rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 0.45rem;
}

.evidence-card:last-of-type {
  margin-bottom: 0;
}

.evidence-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
  color: var(--text-primary);
}

.evidence-error {
  color: var(--coral);
  font-size: 0.78rem;
}

.evidence-card dl {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 0.45rem 0.75rem;
  margin: 0;
}

.evidence-card dt {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.evidence-card dd {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.raw-evidence {
  margin-top: 0.75rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.raw-evidence summary {
  cursor: pointer;
}

.raw-evidence pre {
  margin: 0.5rem 0 0;
  padding: 0.75rem;
  max-height: 180px;
  overflow: auto;
  color: #f3f4f6;
  background: #111827;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  white-space: pre-wrap;
  font-size: 0.75rem;
}

.auto-progress {
  height: 10px;
  background: var(--bg-secondary);
  border-radius: 5px;
  overflow: hidden;
  margin: 1rem 0 0.5rem;
}

.auto-progress.compact {
  height: 7px;
  margin: 0 0 0.45rem;
  background: rgba(148, 163, 184, 0.18);
}

.auto-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}

.auto-load-meta {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin: 0.4rem 0;
}

.auto-load-error {
  padding: 0.65rem 0.75rem;
  color: #fecaca;
  background: rgba(127, 29, 29, 0.28);
  border: 1px solid rgba(248, 113, 113, 0.55);
  border-radius: 0.45rem;
  font-size: 0.82rem;
  line-height: 1.45;
  white-space: pre-wrap;
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
