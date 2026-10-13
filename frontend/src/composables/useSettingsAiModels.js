// The Settings page's AI model defaults: the default-model cards per profile,
// saving them, and the Settings-only wording around the model registry. The
// model list, flag keys, per-model labels and the Anime / Realistic stacks come
// from the shared registry (useAiModelRegistry.js).
import { computed, ref } from 'vue'
import api from '../api/client'
import {
  aiModelRegistry,
  aiProfileIds,
  builtInProfileStack,
  completeModelStack,
  isSemanticModel,
  loadAiModelRegistry,
  modelFlags,
  modelInfoTitle as registryModelInfoTitle,
  modelPipelineDescription as registryModelPipelineDescription,
  modelPipelineLabel,
  modelSettingKey,
  normalizeAiModelDefaults,
} from './useAiModelRegistry'

export { isSemanticModel, modelPipelineLabel, modelSettingKey }

const SETTINGS_PIPELINE_FALLBACK = 'Use this model in the saved default auto-tagging pipeline.'

// Saved stacks as stored: Custom falls back to `fallback`, the others to nothing.
function savedProfileStacks(raw = {}, fallback = {}) {
  const defaults = raw && typeof raw === 'object' ? raw : {}
  return aiProfileIds.reduce((memo, profileId) => {
    memo[profileId] = normalizeAiModelDefaults(defaults[profileId] || (profileId === 'custom' ? fallback : {}))
    return memo
  }, {})
}

export function profileModelDescription(profileId, model) {
  if (profileId === 'anime' && model.key === 'wdEnabled') return 'Usually off for anime; enable only if you want WD broad booru backup tags.'
  if (profileId === 'anime' && model.key === 'pixaiEnabled') return 'Recommended fast anime/Danbooru tagger for illustration-heavy posts.'
  if (profileId === 'realistic' && model.key === 'qwenEnabled') return 'When enabled, Qwen replaces WD for Realistic semantic runs.'
  if (profileId === 'realistic' && model.key === 'pixaiEnabled') return 'Optional; useful for stylized/anime-like realistic edits, otherwise keep off.'
  return model.description
}

export function modelPipelineDescription(id) {
  return registryModelPipelineDescription(id, SETTINGS_PIPELINE_FALLBACK)
}

export function modelPipelineConfigurable(model) {
  if (!isSemanticModel(model)) return true
  return model.id === 'qwen'
}

export function semanticBackendDescription(model) {
  if (model.id === 'qwen') {
    return 'Current Transformers backend. Highest integration stability, largest download and VRAM footprint.'
  }
  if (model.id === 'qwen_gguf_q4') {
    return 'Qwen3-VL 8B Q4_K_M. Best speed and memory profile for local previews.'
  }
  if (model.id === 'qwen_gguf_q8') {
    return 'Qwen3-VL 8B Q8_0. Better quality than Q4 with a larger download and VRAM footprint.'
  }
  return 'Semantic backend used whenever Qwen semantic tags are enabled.'
}

export function modelInfoTitle(model) {
  return registryModelInfoTitle(model, SETTINGS_PIPELINE_FALLBACK)
}

export function useSettingsAiModels({ autoTag, models }) {
  const { autoTagSettings } = autoTag
  const { selectedSemanticModel } = models

  const aiModelDefaults = ref({})
  const aiModelProfileDefaults = ref({
    custom: {},
    anime: {},
    realistic: {},
  })
  const aiModelDefaultsPersisted = ref(false)
  const savingAiModelDefaults = ref(false)
  const aiModelDefaultsStatus = ref({
    show: false,
    success: true,
    message: '',
  })

  async function loadAiModelDefaults() {
    try {
      const [result] = await Promise.all([api.getAiModelDefaults(), loadAiModelRegistry()])
      const modelDefaults = normalizeAiModelDefaults(result.modelDefaults)
      const profileDefaults = savedProfileStacks(result.modelDefaults?.profileDefaults, modelDefaults)
      aiModelDefaultsPersisted.value = Object.keys(modelDefaults).length > 0
      aiModelDefaults.value = modelDefaults
      aiModelProfileDefaults.value = profileDefaults
      hydrateAiModelDefaults()
    } catch (e) {
      console.error('Failed to load AI model defaults:', e)
      hydrateAiModelDefaults()
    }
  }

  async function saveAiModelDefaults() {
    savingAiModelDefaults.value = true
    aiModelDefaultsStatus.value.show = false
    try {
      hydrateAiModelDefaults()
      const result = await api.updateAiModelDefaults(aiModelDefaultsPayload())
      aiModelDefaults.value = normalizeAiModelDefaults(result.modelDefaults)
      aiModelProfileDefaults.value = savedProfileStacks(result.modelDefaults?.profileDefaults, aiModelDefaults.value)
      aiModelDefaultsPersisted.value = true
      hydrateAiModelDefaults()
      aiModelDefaultsStatus.value = {
        show: true,
        success: true,
        message: 'AI model defaults saved.',
      }
    } catch (e) {
      aiModelDefaultsStatus.value = {
        show: true,
        success: false,
        message: 'Failed to save AI model defaults: ' + e.message,
      }
    } finally {
      savingAiModelDefaults.value = false
    }
  }

  // The live auto-tag settings as a stack: a flag never saved takes its
  // AutoTagOptions default, and a mirrored flag (semanticPoliticalEnabled)
  // also turns its source on.
  function autoTagDefaultsForAiModels() {
    const current = autoTagSettings.value || {}
    const mirrors = Object.entries(aiModelRegistry.value.mirroredFlags)
    return modelFlags().reduce((memo, flag) => {
      const value = current[flag.key]
      memo[flag.key] = value === undefined ? flag.defaultEnabled === true : value === true
      for (const [mirror, source] of mirrors) {
        if (source === flag.key && current[mirror] === true) memo[flag.key] = true
      }
      return memo
    }, {})
  }

  function hydrateAiModelDefaults() {
    const fallback = autoTagDefaultsForAiModels()
    const current = normalizeAiModelDefaults(aiModelDefaults.value)
    const customDefaults = modelFlags().reduce((memo, flag) => {
      memo[flag.key] = aiModelDefaultsPersisted.value && Object.prototype.hasOwnProperty.call(current, flag.key)
        ? current[flag.key]
        : fallback[flag.key]
      return memo
    }, {})
    aiModelDefaults.value = customDefaults
    const currentProfiles = savedProfileStacks(aiModelProfileDefaults.value, customDefaults)
    aiModelProfileDefaults.value = {
      custom: customDefaults,
      anime: hydrateProfileDefaults('anime', currentProfiles.anime),
      realistic: hydrateProfileDefaults('realistic', currentProfiles.realistic),
    }
  }

  function hydrateProfileDefaults(profileId, current) {
    if (aiModelDefaultsPersisted.value && Object.keys(current || {}).length) {
      return completeModelStack(current)
    }
    return completeModelStack(builtInProfileStack(profileId))
  }

  function aiModelDefaultsPayload() {
    const profiles = savedProfileStacks(aiModelProfileDefaults.value, normalizeAiModelDefaults(aiModelDefaults.value))
    return {
      ...completeModelStack(profiles.custom),
      profileDefaults: aiProfileIds.reduce((memo, profileId) => {
        memo[profileId] = completeModelStack(profiles[profileId])
        return memo
      }, {}),
    }
  }

  const aiDefaultModels = computed(() => modelFlags().map((flag) => ({
    key: flag.key,
    name: flag.key === 'qwenEnabled' ? (selectedSemanticModel.value?.name || flag.name) : flag.name,
    description: flag.description,
  })))

  const aiDefaultProfiles = computed(() => [
    {
      id: 'custom',
      name: 'Custom profile',
      description: 'Used by Custom AI Tag buttons, imports, and bulk jobs.',
    },
    {
      id: 'anime',
      name: 'Anime / Booru profile',
      description: 'Used when you click Anime / Booru on posts, uploads, or the extension.',
    },
    {
      id: 'realistic',
      name: 'Realistic profile',
      description: 'Used when you click Realistic on posts, uploads, or the extension.',
    },
  ])

  function aiDefaultModelSummary(profileId = 'custom') {
    const defaults = aiModelProfileDefaults.value?.[profileId] || {}
    const count = modelFlags().filter((flag) => defaults[flag.key] === true).length
    return `${count} model${count === 1 ? '' : 's'} enabled`
  }
  return {
    aiModelDefaults,
    aiModelProfileDefaults,
    aiModelDefaultsPersisted,
    savingAiModelDefaults,
    aiModelDefaultsStatus,
    loadAiModelDefaults,
    saveAiModelDefaults,
    hydrateAiModelDefaults,
    aiDefaultModels,
    aiDefaultProfiles,
    aiDefaultModelSummary,
  }
}
