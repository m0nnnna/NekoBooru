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
          <template v-if="tweetUrl">
            <dt>Tweet</dt>
            <dd>
              <a class="external-link" :href="tweetUrl" target="_blank" rel="noopener noreferrer">
                Open Tweet
              </a>
            </dd>
          </template>
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

      <div v-if="semanticSidebarAnalysis" class="sidebar-section semantic-description-section">
        <h3>Semantic Description</h3>
        <div class="semantic-description-card">
          <div class="semantic-description-meta">
            <div>
              <strong>{{ semanticSidebarAnalysis.model }}</strong>
              <small>{{ semanticSidebarAnalysis.profile }}{{ semanticSidebarAnalysis.timing ? ` · ${semanticSidebarAnalysis.timing}` : '' }}</small>
            </div>
            <button
              v-if="editingAiAnalysisId !== semanticSidebarAnalysis.id"
              type="button"
              class="semantic-description-edit"
              @click="startEditAiAnalysis(semanticSidebarAnalysis)"
            >
              Edit
            </button>
          </div>
          <template v-if="editingAiAnalysisId === semanticSidebarAnalysis.id">
            <textarea
              v-model="aiAnalysisDescriptionDraft"
              class="semantic-description-editor"
              rows="8"
              spellcheck="true"
            ></textarea>
            <div class="semantic-description-actions">
              <button
                type="button"
                class="link-btn"
                @click="cancelEditAiAnalysis"
                :disabled="savingAiAnalysis"
              >
                Cancel
              </button>
              <button
                type="button"
                class="link-btn primary"
                @click="saveAiAnalysisDescription(semanticSidebarAnalysis)"
                :disabled="savingAiAnalysis"
              >
                {{ savingAiAnalysis ? 'Saving...' : 'Save' }}
              </button>
            </div>
            <small v-if="aiAnalysisEditError" class="saved-analysis-error">{{ aiAnalysisEditError }}</small>
          </template>
          <template v-else>
            <p>{{ semanticSidebarAnalysis.description }}</p>
          </template>
          <div v-if="semanticSidebarAnalysis.tags.length" class="semantic-description-tags">
            <span v-for="tag in semanticSidebarAnalysis.tags" :key="tag">{{ tag }}</span>
          </div>
        </div>
      </div>

      <div class="sidebar-section">
        <h3>Tags</h3>
        <TagList :tags="post.tags" />
        <button class="btn btn-secondary edit-tags-btn" @click="openTagEditor">
          Edit Tags
        </button>
        <template v-if="autoTagControlsVisible">
        <div class="ai-profile-actions" aria-label="AI tag preview profiles">
          <button
            v-for="profile in autoTagProfiles"
            :key="profile.id"
            type="button"
            class="btn btn-secondary ai-profile-btn"
            :class="{ active: activeAutoTagProfile === profile.id }"
            :disabled="autoTagLoading"
            :data-tooltip="profile.tooltip"
            @click="previewAutoTags(profile.id)"
          >
            {{ autoTagLoading && activeAutoTagProfile === profile.id ? 'Running...' : profile.label }}
          </button>
        </div>
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
                  {{ model.statusLabel }}
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
        </template>
      </div>

      <div class="sidebar-section">
        <h3>Similar</h3>
        <button class="btn btn-secondary similar-btn" @click="loadSimilar" :disabled="similarLoading">
          {{ similarLoading ? 'Searching...' : 'Find Similar' }}
        </button>
        <div v-if="similarLoaded && !similar.length" class="similar-empty">
          No visually similar posts found.
        </div>
        <div v-if="similar.length" class="similar-grid">
          <router-link
            v-for="item in similar"
            :key="item.post.id"
            :to="`/post/${item.post.id}`"
            class="similar-thumb"
            :title="`distance ${item.distance}`"
          >
            <img :src="item.post.thumbUrl" :alt="item.post.filename" loading="lazy" />
          </router-link>
        </div>
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
        <div class="tag-editor-toolbar">
          <div class="segmented-control" aria-label="Tag editor mode">
            <button
              type="button"
              :class="{ active: tagEditorMode === 'visual' }"
              @click="setTagEditorMode('visual')"
            >
              Pills
            </button>
            <button
              type="button"
              :class="{ active: tagEditorMode === 'raw' }"
              @click="setTagEditorMode('raw')"
            >
              Text
            </button>
          </div>
          <div class="tag-editor-tools">
            <span class="tag-editor-count">{{ editedTags.length }} tags</span>
            <button type="button" class="btn btn-secondary clear-tags-btn" @click="clearEditedTags">
              Clear Tags
            </button>
          </div>
        </div>
        <TagInput v-if="tagEditorMode === 'visual'" v-model="editedTags" />
        <div v-else class="raw-tag-editor">
          <textarea
            ref="rawTagTextarea"
            v-model="rawEditedTags"
            spellcheck="false"
            placeholder="One tag per line, comma-separated tags, or a JSON array..."
            @input="onRawTagInput"
            @keydown.down.prevent="onRawTagArrowDown"
            @keydown.up.prevent="onRawTagArrowUp"
            @keydown.enter="onRawTagEnter"
            @keydown.esc="hideRawTagSuggestions"
            @blur="onRawTagBlur"
          ></textarea>
          <ul v-if="rawTagSuggestions.length > 0" class="raw-tag-suggestions">
            <li
              v-for="(tag, index) in rawTagSuggestions"
              :key="tag.name"
              :class="{ selected: index === rawTagSelectedIndex }"
              :style="{ borderLeftColor: tag.categoryColor }"
              @mousedown.prevent="selectRawTagSuggestion(tag)"
              @mouseenter="rawTagSelectedIndex = index"
            >
              <span class="tag-name">{{ tag.name }}</span>
              <span class="tag-count">{{ tag.usageCount }}</span>
            </li>
          </ul>
          <p class="raw-tag-hint">
            Accepts JSON arrays, {"tags": [...]}, commas, new lines, or spaces. Tags are normalized to lowercase underscores.
          </p>
        </div>
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
      <div class="modal auto-tag-preview-modal">
        <h2>AI Tag Preview</h2>
        <p v-if="autoTagTimingLabel" class="auto-timing">Completed in {{ autoTagTimingLabel }}</p>
        <div class="auto-tag-preview-body">
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
            <label v-if="autoTagHasSemanticEvidence" class="save-analysis-toggle">
              <input type="checkbox" v-model="saveSemanticAnalysisForPreview" />
              <span>
                <strong>Save Qwen semantic analysis</strong>
                <small>Stores rationale, semantic tags, raw output, and timing so semantic search can find this post by phrases.</small>
              </span>
            </label>
            <div v-if="autoTagSemanticPreview" class="semantic-preview-card">
              <div class="semantic-preview-head">
                <div>
                  <strong>Semantic Analysis</strong>
                  <small>{{ autoTagSemanticPreview.model }}{{ autoTagSemanticPreview.timing ? ` · ${autoTagSemanticPreview.timing}` : '' }}</small>
                </div>
                <span v-if="autoTagSemanticPreview.safety">{{ autoTagSemanticPreview.safety }}</span>
              </div>
              <p>{{ autoTagSemanticPreview.rationale || autoTagSemanticPreview.summary || autoTagSemanticPreview.raw }}</p>
              <div v-if="autoTagSemanticPreview.tags.length" class="semantic-preview-tags">
                <span v-for="tag in autoTagSemanticPreview.tags" :key="tag">{{ tag }}</span>
              </div>
            </div>
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
import { usePostsStore } from '../stores/posts'
import { useTagsStore } from '../stores/tags'
import MediaViewer from '../components/MediaViewer.vue'
import TagList from '../components/TagList.vue'
import TagInput from '../components/TagInput.vue'
import CommentSection from '../components/CommentSection.vue'

const route = useRoute()
const router = useRouter()
const postsStore = usePostsStore()
const tagsStore = useTagsStore()

const post = ref(null)
const prevId = ref(null)
const nextId = ref(null)
const loading = ref(true)
const similar = ref([])
const similarLoading = ref(false)
const similarLoaded = ref(false)
const postAiAnalyses = ref([])
const editingAiAnalysisId = ref(null)
const aiAnalysisDescriptionDraft = ref('')
const savingAiAnalysis = ref(false)
const aiAnalysisEditError = ref('')
const showTagEditor = ref(false)
const showPoolModal = ref(false)
const showAutoTagModal = ref(false)
const editedTags = ref([])
const tagEditorMode = ref('visual')
const rawEditedTags = ref('')
const rawTagTextarea = ref(null)
const rawTagSuggestions = ref([])
const rawTagSelectedIndex = ref(-1)
const NAME_PART_AUTOCOMPLETE_KEY = 'nekobooru.namePartAutocompleteEnabled'
const DEFAULT_AUTO_TAG_MODELS = [
  {
    id: 'wd',
    name: 'WD Tagger',
    repoId: 'SmilingWolf/wd-eva02-large-tagger-v3',
    purpose: 'Booru-style image and sampled video-frame tags',
    downloadSize: '~1.2 GB',
    vramRequirement: '~0.5-1.5 GB',
  },
  {
    id: 'camie',
    name: 'Camie Tagger v2',
    repoId: 'Camais03/camie-tagger-v2',
    purpose: 'Anime character, copyright, artist, rating, and broad tag coverage',
    downloadSize: '~1-3 GB',
    vramRequirement: '~0.5-2 GB',
  },
  {
    id: 'pixai',
    name: 'PixAI Tagger v0.9',
    repoId: 'deepghs/pixai-tagger-v0.9-onnx',
    purpose: 'Fast PixAI/Danbooru anime and illustration tags',
    downloadSize: '~1.3 GB',
    vramRequirement: '~0.5-1.5 GB',
  },
  {
    id: 'qwen',
    name: 'Qwen2.5-VL 7B Instruct',
    repoId: 'Qwen/Qwen2.5-VL-7B-Instruct',
    purpose: 'Semantic video/edit understanding, political context, and natural-language evidence',
    downloadSize: '~15-17 GB',
    vramRequirement: '~14-18 GB fp16, 24 GB comfortable',
  },
  {
    id: 'ocr',
    name: 'TrOCR Printed',
    repoId: 'microsoft/trocr-base-printed',
    purpose: 'Text extraction from meme/edit frames and subtitles',
    downloadSize: '~1.3 GB',
    vramRequirement: '~1-2 GB',
  },
  {
    id: 'whisper',
    name: 'Whisper Small',
    repoId: 'openai/whisper-small',
    purpose: 'Speech/audio transcript signals for AMVs and edits',
    downloadSize: '~1 GB',
    vramRequirement: '~1-2 GB',
  },
]
const autoTagEditedTags = ref([])
const autoTagEditedSafety = ref('safe')
const autoTagSuggestion = ref(null)
const saveSemanticAnalysisForPreview = ref(false)
const autoTagLoading = ref(false)
const autoTagStatus = ref({ enabled: true, models: DEFAULT_AUTO_TAG_MODELS })
const postAutoTagSettings = ref({
  wdEnabled: true,
  pixaiEnabled: false,
  characterModelEnabled: false,
  ocrEnabled: false,
  whisperEnabled: false,
  qwenEnabled: false,
  semanticPoliticalEnabled: false,
  semanticModelId: 'qwen',
  semanticPromptEnabled: true,
  semanticSearchEnabled: false,
  saveSemanticAnalysis: false,
})
const savedAutoTagSettings = ref({ ...postAutoTagSettings.value })
const savedAutoTagProfileDefaults = ref({ custom: {}, anime: {}, realistic: {} })
const activeAutoTagProfile = ref('')
const previewAutoTagProfile = ref('post')
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
let rawTagDebounceTimer = null
const pools = ref([])
const selectedPool = ref('')

const mediaType = computed(() => {
  if (!post.value) return 'image'
  const ext = post.value.extension
  if (['.webm', '.mp4'].includes(ext)) return 'video'
  if (ext === '.gif') return 'gif'
  return 'image'
})

const tweetUrl = computed(() => {
  const id = tweetIdFromPost(post.value)
  return id ? `https://x.com/i/status/${id}` : ''
})

const safetyOptions = [
  { value: 'safe', label: 'Safe' },
  { value: 'sketchy', label: 'Sketchy' },
  { value: 'unsafe', label: 'Unsafe / NSFW' },
]

const autoTagProfiles = [
  {
    id: 'anime',
    label: 'Anime / Booru',
    tooltip: 'Best for anime, manga, illustrations, and booru-style art. Uses the Anime / Booru model stack from Settings, typically PixAI/Camie plus TrOCR; videos can add Whisper. If Qwen is enabled for Anime, it adds semantic context.',
  },
  {
    id: 'realistic',
    label: 'Realistic',
    tooltip: 'Best for realistic photos, screenshots, videos, edits, and memes. Uses the Realistic model stack from Settings. If Qwen is enabled for Realistic, it replaces WD as the primary visual/semantic model.',
  },
  {
    id: 'custom',
    label: 'Custom',
    tooltip: 'Runs exactly the model checkboxes currently selected below. This does not change your saved defaults.',
  },
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

const autoTagHasSemanticEvidence = computed(() =>
  autoTagEvidenceModels.value.some((model) => {
    const evidence = model.evidence || {}
    const marker = `${evidence.kind || ''} ${evidence.modelId || ''} ${model.model || ''}`.toLowerCase()
    return marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
  })
)

const autoTagSemanticPreview = computed(() => {
  for (const model of autoTagEvidenceModels.value) {
    const evidence = model.evidence || {}
    const parsed = semanticParsedEvidence(evidence)
    const marker = `${evidence.kind || ''} ${evidence.modelId || ''} ${model.model || ''}`.toLowerCase()
    const isSemantic = marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
    if (!isSemantic) continue
    const rationale = String(parsed.rationale || parsed.description || parsed.summary || '').trim()
    const raw = String(evidence.raw || '').trim()
    const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : []
    if (!rationale && !raw && !tags.length) continue
    return {
      model: model.model || evidence.modelId || 'Qwen',
      timing: formatDurationMs(model.durationMs ?? evidence.durationMs),
      safety: parsed.safety || '',
      rationale,
      summary: String(parsed.summary || parsed.description || '').trim(),
      raw,
      tags,
    }
  }
  return null
})

const semanticSidebarAnalysis = computed(() => {
  for (const analysis of postAiAnalyses.value || []) {
    const description = aiAnalysisDescription(analysis)
    if (!description) continue
    const rawParsed = parseSemanticRawOutput(analysis.rawOutput)
    const semanticTags = Array.isArray(analysis.semanticTags) && analysis.semanticTags.length
      ? analysis.semanticTags
      : (Array.isArray(rawParsed.tags) ? rawParsed.tags : [])
    return {
      id: analysis.id,
      model: analysis.modelName || analysis.modelId || 'Qwen',
      profile: analysis.profile || 'default',
      timing: formatDurationMs(analysis.durationMs),
      description,
      tags: semanticTags.map(String).filter(Boolean).slice(0, 12),
    }
  }
  return null
})

const autoTagTimingLabel = computed(() => {
  const duration = Number(autoTagSuggestion.value?.durationMs ?? autoTagSuggestion.value?.evidence?.durationMs)
  return Number.isFinite(duration) && duration > 0 ? formatDurationMs(duration) : ''
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
  const models = autoTagStatus.value?.models?.length ? autoTagStatus.value.models : DEFAULT_AUTO_TAG_MODELS
  const selectedSemantic = postAutoTagSettings.value.semanticModelId || savedAutoTagSettings.value.semanticModelId || autoTagStatus.value?.semanticModelId || 'qwen'
  return models.filter((model) => !isSemanticModel(model) || model.id === selectedSemantic).map((model) => ({
    ...model,
    settingKey: modelSettingKey(model.id),
    canToggle: true,
    downloaded: model.downloaded === true,
    loaded: model.loaded === true,
    runtimeAvailable: model.runtimeAvailable !== false,
    statusLabel: model.downloaded === true ? 'downloaded' : model.downloaded === false ? 'not downloaded' : 'checking',
  }))
})
const autoTagControlsVisible = computed(() => autoTagStatus.value?.enabled !== false || autoTagStatus.value?.models?.length)

onMounted(async () => {
  await loadPost()
  loadNeighbors()
  window.addEventListener('keydown', onKeydown)
  loadPools()
  loadAutoTagControls()
})

onUnmounted(() => {
  stopAutoLoadPolling()
  stopAutoTagTimer()
  window.removeEventListener('keydown', onKeydown)
})

watch(() => route.params.id, async () => {
  await loadPost()
  loadNeighbors()
  similar.value = []
  similarLoaded.value = false
})

async function loadSimilar() {
  similarLoading.value = true
  try {
    const result = await api.getSimilarPosts(route.params.id)
    similar.value = result.results || []
    similarLoaded.value = true
  } catch (e) {
    alert('Failed to find similar posts: ' + e.message)
  } finally {
    similarLoading.value = false
  }
}

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

function modelSettingKey(id) {
  return {
    wd: 'wdEnabled',
    pixai: 'pixaiEnabled',
    camie: 'characterModelEnabled',
    ocr: 'ocrEnabled',
    whisper: 'whisperEnabled',
    qwen: 'qwenEnabled',
    qwen_gguf_q4: 'qwenEnabled',
    qwen_gguf_q8: 'qwenEnabled',
  }[id] || `${id}Enabled`
}

function isSemanticModel(model) {
  return model?.role === 'semantic' || ['qwen', 'qwen_gguf_q4', 'qwen_gguf_q8'].includes(model?.id)
}

function modelPipelineDescription(id) {
  return {
    wd: 'Runs on images and sampled video frames. Best baseline for visual library tags.',
    pixai: 'Runs fast PixAI/Danbooru anime tags on images and sampled video frames.',
    camie: 'Adds anime characters, copyright/source tags, artist tags, and rating evidence.',
    ocr: 'Reads visible captions, subtitles, and meme text from representative frames.',
    whisper: 'Extracts speech from video audio for AMVs, edits, narration, and spoken context.',
    qwen: 'Uses image plus OCR/transcript context for higher-level edit and scene meaning.',
    qwen_gguf_q4: 'Uses Qwen3-VL GGUF Q4 through llama.cpp for faster low-memory semantic tags.',
    qwen_gguf_q8: 'Uses Qwen3-VL GGUF Q8 through llama.cpp for higher-quality semantic tags.',
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
    model.providers?.length ? `Provider: ${model.providers.join(', ')}` : null,
  ].filter(Boolean).join('\n')
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
  const parsed = semanticParsedEvidence(evidence)
  const rows = []
  const duration = Number(model.durationMs ?? evidence.durationMs)
  if (Number.isFinite(duration) && duration > 0) {
    rows.push({ label: 'Time', value: formatDurationMs(duration) })
  }
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
  if (parsed.tags?.length) rows.push({ label: 'Semantic tags', value: parsed.tags.join(', ') })
  if (parsed.safety) rows.push({ label: 'Semantic safety', value: parsed.safety })
  if (parsed.rationale) rows.push({ label: 'Semantic analysis', value: String(parsed.rationale).slice(0, 800) })
  if (evidence.raw && !rows.some((row) => row.label === 'Semantic tags')) {
    rows.push({ label: 'Model output', value: String(evidence.raw).slice(0, 500) })
  }
  if (!rows.length && model.error) rows.push({ label: 'Status', value: model.error })
  if (!rows.length) rows.push({ label: 'Details', value: 'No structured evidence returned.' })
  return rows
}

function semanticParsedEvidence(evidence) {
  if (evidence?.parsed && typeof evidence.parsed === 'object') return evidence.parsed
  const raw = String(evidence?.raw || '').trim()
  if (!raw) return {}
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function parseSemanticRawOutput(raw) {
  const text = String(raw || '').trim()
  if (!text) return {}
  try {
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    const rationale = extractJsonStringFragment(text, 'rationale')
    const description = extractJsonStringFragment(text, 'description')
    const summary = extractJsonStringFragment(text, 'summary')
    return { rationale, description, summary }
  }
}

function extractJsonStringFragment(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quoted = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i').exec(text)
  const fragment = quoted?.[1] || new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*)$`, 'i').exec(text)?.[1] || ''
  return fragment
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/[}\],\s]*$/g, '')
    .trim()
}

function cleanSemanticDescription(value) {
  const text = String(value || '').trim()
  if (/^[{\[]/.test(text)) return ''
  return text
    .replace(/\s+/g, ' ')
    .replace(/^rationale:\s*/i, '')
    .trim()
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

function formatDurationMs(ms) {
  const value = Number(ms || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

async function loadAutoTagControls() {
  try {
    const [settingsResult, statusResult, defaultsResult] = await Promise.all([
      api.getAutoTagSettings(),
      api.getAutoTagStatus(),
      api.getAiModelDefaults(),
    ])
    const modelDefaults = normalizeAiModelDefaults(defaultsResult?.modelDefaults)
    savedAutoTagProfileDefaults.value = normalizeAiProfileDefaults(defaultsResult?.modelDefaults?.profileDefaults, modelDefaults)
    postAutoTagSettings.value = {
      ...settingsResult,
      wdEnabled: settingsResult.wdEnabled !== false,
      semanticPromptEnabled: settingsResult.semanticPromptEnabled !== false,
      semanticSearchEnabled: settingsResult.semanticSearchEnabled === true,
      saveSemanticAnalysis: settingsResult.saveSemanticAnalysis === true,
      semanticModelId: settingsResult.semanticModelId || 'qwen',
      ...modelDefaults,
    }
    if (Object.prototype.hasOwnProperty.call(modelDefaults, 'qwenEnabled')) {
      postAutoTagSettings.value.semanticPoliticalEnabled = modelDefaults.semanticPoliticalEnabled ?? modelDefaults.qwenEnabled
    }
    savedAutoTagSettings.value = { ...postAutoTagSettings.value }
    autoTagStatus.value = statusResult
  } catch (e) {
    console.error('Failed to load AI tag controls:', e)
  }
}

function normalizeAiModelDefaults(raw = {}) {
  const defaults = raw && typeof raw === 'object' ? raw : {}
  const normalized = {}
  for (const key of ['wdEnabled', 'pixaiEnabled', 'characterModelEnabled', 'qwenEnabled', 'semanticPoliticalEnabled', 'ocrEnabled', 'whisperEnabled']) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      normalized[key] = defaults[key] === true
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'qwenEnabled') && !Object.prototype.hasOwnProperty.call(normalized, 'semanticPoliticalEnabled')) {
    normalized.semanticPoliticalEnabled = normalized.qwenEnabled
  }
  return normalized
}

function normalizeAiProfileDefaults(raw = {}, fallback = {}) {
  const profiles = raw && typeof raw === 'object' ? raw : {}
  const defaults = {
    custom: fallback,
    anime: { wdEnabled: false, pixaiEnabled: true, characterModelEnabled: true, qwenEnabled: false, semanticPoliticalEnabled: false, ocrEnabled: true, whisperEnabled: true },
    realistic: { wdEnabled: true, pixaiEnabled: false, characterModelEnabled: false, qwenEnabled: false, semanticPoliticalEnabled: false, ocrEnabled: true, whisperEnabled: true },
  }
  return ['custom', 'anime', 'realistic'].reduce((memo, profileId) => {
    memo[profileId] = {
      ...defaults[profileId],
      ...normalizeAiModelDefaults(profiles[profileId] || {}),
    }
    return memo
  }, {})
}

async function loadPost() {
  loading.value = true
  try {
    post.value = await api.getPost(route.params.id)
    editedTags.value = [...post.value.tags]
    loadPostAiAnalysis()
  } catch (e) {
    post.value = null
    postAiAnalyses.value = []
  } finally {
    loading.value = false
  }
}

async function loadPostAiAnalysis() {
  if (!post.value?.id) return
  try {
    const result = await api.getPostAiAnalysis(post.value.id)
    postAiAnalyses.value = result.results || []
  } catch {
    postAiAnalyses.value = []
  }
}

function aiAnalysisDescription(analysis) {
  if (analysis?.description) return String(analysis.description).trim()
  return cleanSemanticDescription(
    semanticDescriptionFromField(analysis?.rationale) ||
    semanticDescriptionFromField(analysis?.summary) ||
    semanticDescriptionFromField(analysis?.rawOutput)
  )
}

function semanticDescriptionFromField(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (!/^[{\[]/.test(text)) return text
  const parsed = parseSemanticRawOutput(text)
  return (
    parsed.rationale ||
    parsed.description ||
    parsed.summary ||
    parsed.scene ||
    ''
  )
}

function startEditAiAnalysis(analysis) {
  editingAiAnalysisId.value = analysis.id
  aiAnalysisDescriptionDraft.value = aiAnalysisDescription(analysis)
  aiAnalysisEditError.value = ''
}

function cancelEditAiAnalysis() {
  editingAiAnalysisId.value = null
  aiAnalysisDescriptionDraft.value = ''
  aiAnalysisEditError.value = ''
}

async function saveAiAnalysisDescription(analysis) {
  if (!post.value?.id || !analysis?.id) return
  savingAiAnalysis.value = true
  aiAnalysisEditError.value = ''
  try {
    const updated = await api.updatePostAiAnalysis(post.value.id, analysis.id, {
      description: aiAnalysisDescriptionDraft.value,
    })
    postAiAnalyses.value = postAiAnalyses.value.map((item) => (
      item.id === updated.id ? updated : item
    ))
    cancelEditAiAnalysis()
  } catch (error) {
    aiAnalysisEditError.value = error.message || 'Failed to save description.'
  } finally {
    savingAiAnalysis.value = false
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

function openTagEditor() {
  editedTags.value = [...(post.value?.tags || [])]
  tagEditorMode.value = 'visual'
  rawEditedTags.value = tagsToRawText(editedTags.value)
  showTagEditor.value = true
}

function setTagEditorMode(mode) {
  if (mode === tagEditorMode.value) return
  if (tagEditorMode.value === 'raw') {
    editedTags.value = parseRawTags(rawEditedTags.value)
    hideRawTagSuggestions()
  } else {
    rawEditedTags.value = tagsToRawText(editedTags.value)
  }
  tagEditorMode.value = mode
}

function clearEditedTags() {
  editedTags.value = []
  rawEditedTags.value = ''
  hideRawTagSuggestions()
}

function tagsToRawText(tags) {
  return (tags || []).join('\n')
}

function normalizeTagName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_')
}

function parseRawTags(raw) {
  const text = String(raw || '').trim()
  if (!text) return []

  let values = null
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) values = parsed
      else if (Array.isArray(parsed?.tags)) values = parsed.tags
    } catch {
      values = null
    }
  }

  if (!values) {
    values = text.split(/[\s,]+/)
  }

  const seen = new Set()
  const tags = []
  for (const value of values) {
    const tag = normalizeTagName(value)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

function rawTagTokenAtCursor() {
  const textarea = rawTagTextarea.value
  const value = rawEditedTags.value || ''
  const cursor = textarea?.selectionStart ?? value.length
  let start = cursor
  while (start > 0 && !/[\s,\[\]{}"']/.test(value[start - 1])) start -= 1
  let end = cursor
  while (end < value.length && !/[\s,\[\]{}"']/.test(value[end])) end += 1
  const rawToken = value.slice(start, end)
  const token = rawToken.startsWith('-') ? rawToken.slice(1) : rawToken
  return { start, end, rawToken, token }
}

function onRawTagInput() {
  clearTimeout(rawTagDebounceTimer)
  rawTagDebounceTimer = setTimeout(async () => {
    const { token } = rawTagTokenAtCursor()
    if (!token || token.includes(':')) {
      hideRawTagSuggestions()
      return
    }
    rawTagSuggestions.value = await tagsStore.autocomplete(token, tagAutocompleteOptions())
    rawTagSelectedIndex.value = rawTagSuggestions.value.length ? 0 : -1
  }, 150)
}

function tagAutocompleteOptions() {
  return {
    nameParts: localStorage.getItem(NAME_PART_AUTOCOMPLETE_KEY) === 'true',
  }
}

function selectRawTagSuggestion(tag) {
  if (!tag?.name) return
  const { start, end, rawToken } = rawTagTokenAtCursor()
  const prefix = rawToken.startsWith('-') ? '-' : ''
  const before = rawEditedTags.value.slice(0, start)
  const after = rawEditedTags.value.slice(end)
  const inserted = `${prefix}${tag.name}`
  rawEditedTags.value = `${before}${inserted}${after}`
  hideRawTagSuggestions()
  requestAnimationFrame(() => {
    rawTagTextarea.value?.focus()
    const caret = before.length + inserted.length
    rawTagTextarea.value?.setSelectionRange(caret, caret)
  })
}

function onRawTagEnter(event) {
  if (!rawTagSuggestions.value.length) return
  event.preventDefault()
  const index = rawTagSelectedIndex.value >= 0 ? rawTagSelectedIndex.value : 0
  selectRawTagSuggestion(rawTagSuggestions.value[index])
}

function onRawTagArrowDown() {
  if (!rawTagSuggestions.value.length) return
  rawTagSelectedIndex.value = (rawTagSelectedIndex.value + 1) % rawTagSuggestions.value.length
}

function onRawTagArrowUp() {
  if (!rawTagSuggestions.value.length) return
  rawTagSelectedIndex.value = rawTagSelectedIndex.value <= 0
    ? rawTagSuggestions.value.length - 1
    : rawTagSelectedIndex.value - 1
}

function hideRawTagSuggestions() {
  rawTagSuggestions.value = []
  rawTagSelectedIndex.value = -1
}

function onRawTagBlur() {
  setTimeout(hideRawTagSuggestions, 150)
}

async function saveTags() {
  try {
    if (tagEditorMode.value === 'raw') {
      editedTags.value = parseRawTags(rawEditedTags.value)
    }
    await api.updatePost(post.value.id, { tags: editedTags.value })
    await loadPost()
    showTagEditor.value = false
  } catch (e) {
    alert('Failed to save tags: ' + e.message)
  }
}

async function previewAutoTags(profileId = 'custom') {
  autoTagLoading.value = true
  activeAutoTagProfile.value = profileId
  previewAutoTagProfile.value = profileId
  applyAutoTagProfile(profileId)
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

    const missingDeps = selectedMissingBackendPackages()
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
    saveSemanticAnalysisForPreview.value = Boolean(postAutoTagSettings.value.saveSemanticAnalysis)
    beginAutoTagStage('ready', 'Preview is ready. Review the suggested tags and safety rating before applying.')
    showAutoTagModal.value = true
  } catch (e) {
    beginAutoTagStage('failed', e.message)
    alert(`Failed to preview AI tags: ${e.message}\n\nLarge Qwen runs can take a while. If the backend is still healthy, try again after the model finishes loading.`)
  } finally {
    autoTagLoading.value = false
    activeAutoTagProfile.value = ''
    showAutoProcessModal.value = false
    stopAutoTagTimer()
  }
}

function applyAutoTagProfile(profileId) {
  const profileSettings = autoTagProfileSettings(profileId)
  if (!profileSettings) return
  postAutoTagSettings.value = {
    ...postAutoTagSettings.value,
    ...profileSettings,
  }
}

function autoTagProfileSettings(profileId) {
  if (profileId === 'custom') return null
  const isVideo = mediaType.value === 'video'
  const profileDefaults = savedAutoTagProfileDefaults.value?.[profileId] || {}
  const useSemanticQwen = [
    profileDefaults.qwenEnabled,
    postAutoTagSettings.value.qwenEnabled,
  ].some(Boolean)
  if (profileId === 'anime') {
    return {
      wdEnabled: profileDefaults.wdEnabled === true,
      pixaiEnabled: profileDefaults.pixaiEnabled === true,
      characterModelEnabled: profileDefaults.characterModelEnabled !== false,
      ocrEnabled: profileDefaults.ocrEnabled !== false,
      whisperEnabled: isVideo && profileDefaults.whisperEnabled !== false,
      qwenEnabled: useSemanticQwen,
      semanticPoliticalEnabled: useSemanticQwen,
      semanticModelId: savedAutoTagSettings.value.semanticModelId || 'qwen',
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
      ...(isVideo ? { videoMaxFrames: 4, qwenVideoMaxFrames: savedAutoTagSettings.value.qwenVideoMaxFrames || 1 } : {}),
    }
  }
  if (profileId === 'realistic') {
    return {
      wdEnabled: useSemanticQwen ? false : profileDefaults.wdEnabled !== false,
      pixaiEnabled: profileDefaults.pixaiEnabled === true,
      characterModelEnabled: profileDefaults.characterModelEnabled === true,
      ocrEnabled: profileDefaults.ocrEnabled !== false,
      whisperEnabled: isVideo && profileDefaults.whisperEnabled !== false,
      qwenEnabled: useSemanticQwen,
      semanticPoliticalEnabled: useSemanticQwen,
      semanticModelId: savedAutoTagSettings.value.semanticModelId || 'qwen',
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: isVideo ? 20 : 18,
      ...(isVideo ? { videoMaxFrames: 4, qwenVideoMaxFrames: savedAutoTagSettings.value.qwenVideoMaxFrames || 1 } : {}),
    }
  }
  return null
}

function autoTagRunSettings() {
  const qwenEnabled = postAutoTagSettings.value.qwenEnabled === true
  return {
    ...postAutoTagSettings.value,
    qwenEnabled,
    semanticPoliticalEnabled: qwenEnabled,
    enabled: true,
  }
}

function enabledModelRows() {
  return postModelRows.value.filter((model) => Boolean(postAutoTagSettings.value[model.settingKey]))
}

function selectedMissingBackendPackages() {
  const missing = new Set()
  enabledModelRows().forEach((model) => {
    dependenciesForModel(model).forEach((name) => {
      if (autoTagStatus.value.dependencies?.[name] === false) missing.add(name)
    })
  })
  return Array.from(missing)
}

function dependenciesForModel(model) {
  if (!model) return []
  if (model.id === 'wd' || model.id === 'pixai' || model.id === 'camie') return ['onnxruntime', 'numpy', 'pillow']
  if (model.id === 'ocr' || model.id === 'whisper') return ['transformers', 'torch']
  if (model.id === 'qwen') return ['transformers', 'torch', 'qwen_vl_utils']
  if (model.id === 'qwen_gguf_q4' || model.id === 'qwen_gguf_q8') return ['llama_cpp']
  return []
}

async function loadEnabledAutoTagModels() {
  if (autoTagStatus.value?.remote?.enabled && autoTagStatus.value?.remote?.url) {
    beginAutoTagStage('loading', 'Using the configured AI worker. The worker will load model weights during analysis if needed.')
    return
  }
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
      suggestion: autoTagSuggestion.value || {},
      saveAnalysis: saveSemanticAnalysisForPreview.value === true,
      profile: previewAutoTagProfile.value || 'post',
    })
    editedTags.value = [...post.value.tags]
    await loadPostAiAnalysis()
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

function tweetIdFromPost(value) {
  if (!value) return ''
  const tag = (value.tags || []).find((name) => /^twitter_\d+$/.test(name) || /^tweet_\d+$/.test(name))
  if (tag) return tag.match(/\d+/)?.[0] || ''
  return tweetIdFromUrl(value.source)
}

function tweetIdFromUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return ''
    return url.pathname.match(/\/status\/(\d+)/)?.[1] || ''
  } catch {
    return ''
  }
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

.external-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 700;
}

.external-link:hover {
  text-decoration: underline;
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

.similar-btn {
  width: 100%;
}

.similar-empty {
  margin-top: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.similar-grid {
  margin-top: 0.75rem;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.4rem;
}

.similar-thumb {
  display: block;
  aspect-ratio: 1;
  border-radius: 0.4rem;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.similar-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ai-profile-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
  margin-top: 0.75rem;
}

.ai-profile-btn {
  position: relative;
  min-width: 0;
  padding: 0.55rem 0.45rem;
  font-size: 0.78rem;
  line-height: 1.2;
  white-space: normal;
}

.ai-profile-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.ai-profile-btn::after {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 80;
  display: block;
  width: max-content;
  max-width: min(320px, 76vw);
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.38);
  content: attr(data-tooltip);
  font-size: 0.74rem;
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.ai-profile-btn:hover::after,
.ai-profile-btn:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
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

.save-analysis-toggle {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.65rem;
  align-items: start;
  margin: 0.9rem 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
}

.save-analysis-toggle small {
  display: block;
  margin-top: 0.2rem;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.saved-analysis-card {
  padding: 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.saved-analysis-card + .saved-analysis-card {
  margin-top: 0.5rem;
}

.saved-analysis-card summary {
  display: grid;
  gap: 0.15rem;
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 700;
}

.saved-analysis-card summary small {
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 500;
}

.saved-analysis-body {
  display: grid;
  gap: 0.55rem;
  margin-top: 0.65rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.4;
}

.saved-analysis-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.saved-analysis-tags span {
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--accent);
  border-radius: 0.35rem;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.72rem;
}

.saved-analysis-body pre {
  max-height: 140px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0.55rem;
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 0.72rem;
}

.saved-analysis-editor {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  line-height: 1.45;
}

.saved-analysis-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.45rem;
}

.saved-analysis-edit {
  justify-self: start;
}

.saved-analysis-error {
  color: var(--coral);
}

.semantic-description-card {
  display: grid;
  gap: 0.65rem;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.semantic-description-meta {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.semantic-description-meta > div {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}

.semantic-description-meta strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.semantic-description-meta small {
  color: var(--text-secondary);
  font-size: 0.72rem;
  white-space: nowrap;
}

.semantic-description-card p {
  max-height: 170px;
  margin: 0;
  overflow: auto;
  padding-right: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.45;
}

.semantic-description-edit {
  flex: 0 0 auto;
  padding: 0.18rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.78rem;
  line-height: 1.1;
}

.semantic-description-edit:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.semantic-description-editor {
  width: 100%;
  min-height: 145px;
  resize: vertical;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  line-height: 1.45;
}

.semantic-description-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.semantic-description-actions .link-btn.primary {
  color: var(--accent);
  font-weight: 700;
}

.semantic-description-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.semantic-description-tags span {
  padding: 0.16rem 0.4rem;
  border: 1px solid rgba(96, 165, 250, 0.55);
  border-radius: 0.35rem;
  background: rgba(96, 165, 250, 0.12);
  color: var(--accent);
  font-size: 0.7rem;
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

.auto-tag-preview-modal {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: min(470px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  padding: 0;
  overflow: hidden;
}

.auto-tag-preview-modal h2 {
  margin: 0;
  padding: 1.25rem 1.25rem 0.35rem;
}

.auto-tag-preview-modal .auto-timing {
  margin: 0;
  padding: 0 1.25rem 0.75rem;
}

.auto-tag-preview-body {
  min-height: 0;
  overflow-y: auto;
  padding: 0 1.25rem 1rem;
}

.auto-tag-preview-modal .modal-actions {
  position: sticky;
  bottom: 0;
  margin: 0;
  padding: 0.9rem 1.25rem 1.25rem;
  border-top: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(17, 24, 39, 0.92), var(--bg-primary) 35%);
}

.modal h2 {
  margin-bottom: 1.25rem;
  color: var(--text-primary);
}

.auto-tag-preview-modal h2 {
  margin-bottom: 0;
}

.auto-timing {
  margin: -0.8rem 0 1rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.tag-editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.segmented-control {
  display: inline-flex;
  padding: 0.2rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.segmented-control button {
  min-width: 4rem;
  padding: 0.4rem 0.7rem;
  border: 0;
  border-radius: 0.35rem;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-weight: 600;
}

.segmented-control button.active {
  background: var(--accent);
  color: #fff;
}

.tag-editor-count {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.tag-editor-tools {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.clear-tags-btn {
  padding: 0.4rem 0.7rem;
  font-size: 0.82rem;
}

.raw-tag-editor textarea {
  width: 100%;
  min-height: 260px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  padding: 0.75rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 0.9rem;
  line-height: 1.45;
}

.raw-tag-editor textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.raw-tag-suggestions {
  margin: 0.4rem 0 0;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  box-shadow: 0 4px 12px var(--shadow);
}

.raw-tag-suggestions li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid transparent;
  color: var(--text-primary);
  cursor: pointer;
}

.raw-tag-suggestions li:hover,
.raw-tag-suggestions li.selected {
  background: var(--bg-tertiary);
}

.raw-tag-hint {
  margin: 0.5rem 0 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
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

.semantic-preview-card {
  display: grid;
  gap: 0.65rem;
  margin-top: 1rem;
  padding: 0.85rem;
  border: 1px solid rgba(96, 165, 250, 0.38);
  border-radius: 0.55rem;
  background: rgba(96, 165, 250, 0.08);
}

.semantic-preview-head {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  justify-content: space-between;
}

.semantic-preview-head div {
  display: grid;
  gap: 0.15rem;
}

.semantic-preview-head strong {
  color: var(--text-primary);
}

.semantic-preview-head small {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.semantic-preview-head span {
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
}

.semantic-preview-card p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.86rem;
  line-height: 1.45;
}

.semantic-preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.semantic-preview-tags span {
  padding: 0.2rem 0.4rem;
  border: 1px solid rgba(96, 165, 250, 0.48);
  border-radius: 0.35rem;
  color: var(--accent);
  font-size: 0.72rem;
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

  .auto-tag-preview-modal {
    width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  .auto-tag-preview-body {
    overflow-y: auto;
  }

  .modal h2 {
    font-size: 1.1rem;
    margin-bottom: 1rem;
  }

  .auto-tag-preview-modal h2 {
    margin-bottom: 0;
  }

  .modal-actions {
    flex-direction: column;
    gap: 0.5rem;
  }

  .auto-tag-preview-modal .modal-actions {
    flex-direction: column;
    margin: 0;
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
