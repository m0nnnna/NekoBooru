// The Settings page's AI model lists: the model-key list, the profile ids,
// the model-id -> setting-key map, the pipeline label / description helpers,
// the default-model cards, and the anime / realistic profile-default
// builders. This is the Settings view's copy of the model lists (CLAUDE.md
// "Adding a new tagger model", step 9).
import { computed, ref } from 'vue'
import api from '../api/client'

export const extensionModelDefaultKeys = [
  'wdEnabled',
  'pixaiEnabled',
  'characterModelEnabled',
  'clEnabled',
  'booruLookupEnabled',
  'qwenEnabled',
  'ocrEnabled',
  'whisperEnabled',
]
export const aiDefaultProfileIds = ['custom', 'anime', 'realistic']

export function normalizeAiModelDefaults(raw = {}) {
  const defaults = raw && typeof raw === 'object' ? raw : {}
  return extensionModelDefaultKeys.reduce((memo, key) => {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      memo[key] = defaults[key] === true
    }
    return memo
  }, {})
}

export function normalizeAiProfileDefaults(raw = {}, fallback = {}) {
  const defaults = raw && typeof raw === 'object' ? raw : {}
  return aiDefaultProfileIds.reduce((memo, profileId) => {
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

export function modelSettingKey(id) {
  return {
    wd: 'wdEnabled',
    pixai: 'pixaiEnabled',
    camie: 'characterModelEnabled',
    cl: 'clEnabled',
    ocr: 'ocrEnabled',
    whisper: 'whisperEnabled',
    qwen: 'qwenEnabled',
    qwen_gguf_q4: 'qwenEnabled',
    qwen_gguf_q8: 'qwenEnabled',
  }[id] || `${id}Enabled`
}

export function modelPipelineLabel(id) {
  return {
    wd: 'Enable by default for booru tags',
    pixai: 'Enable by default for PixAI anime tags',
    camie: 'Enable by default for character/source tags',
    cl: 'Enable by default for CL Tagger v2 tags',
    ocr: 'Enable by default for text extraction',
    whisper: 'Enable by default for audio transcripts',
    qwen: 'Enable by default for semantic tags',
    qwen_gguf_q4: 'Enable by default for semantic tags',
    qwen_gguf_q8: 'Enable by default for semantic tags',
  }[id] || 'Enable by default'
}

export function modelPipelineDescription(id) {
  return {
    wd: 'Runs on images and sampled video frames. Best baseline for visual library tags.',
    pixai: 'Runs fast PixAI/Danbooru anime tags on images and sampled video frames.',
    camie: 'Adds anime characters, copyright/source tags, artist tags, and rating evidence.',
    cl: 'SigLIP2 tagger with a 108k-tag Danbooru vocabulary. Gated model: accept its licence on Hugging Face and save a token before downloading.',
    ocr: 'Reads visible captions, subtitles, and meme text from representative frames.',
    whisper: 'Extracts speech from video audio for AMVs, edits, narration, and spoken context.',
    qwen: 'Uses image plus OCR/transcript context for higher-level edit and scene meaning.',
    qwen_gguf_q4: 'Uses Qwen3-VL GGUF Q4 through llama.cpp for faster low-memory semantic tags.',
    qwen_gguf_q8: 'Uses Qwen3-VL GGUF Q8 through llama.cpp for higher-quality semantic tags.',
  }[id] || 'Use this model in the saved default auto-tagging pipeline.'
}

export function isSemanticModel(model) {
  return model?.role === 'semantic' || ['qwen', 'qwen_gguf_q4', 'qwen_gguf_q8'].includes(model?.id)
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
      const result = await api.getAiModelDefaults()
      const modelDefaults = normalizeAiModelDefaults(result.modelDefaults)
      const profileDefaults = normalizeAiProfileDefaults(result.modelDefaults?.profileDefaults, modelDefaults)
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
      aiModelProfileDefaults.value = normalizeAiProfileDefaults(result.modelDefaults?.profileDefaults, aiModelDefaults.value)
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

  function autoTagDefaultsForAiModels() {
    return {
      wdEnabled: autoTagSettings.value.wdEnabled !== false,
      pixaiEnabled: autoTagSettings.value.pixaiEnabled === true,
      characterModelEnabled: autoTagSettings.value.characterModelEnabled === true,
      clEnabled: autoTagSettings.value.clEnabled === true,
      booruLookupEnabled: autoTagSettings.value.booruLookupEnabled === true,
      qwenEnabled: Boolean(autoTagSettings.value.qwenEnabled || autoTagSettings.value.semanticPoliticalEnabled),
      ocrEnabled: autoTagSettings.value.ocrEnabled === true,
      whisperEnabled: autoTagSettings.value.whisperEnabled === true,
    }
  }

  function hydrateAiModelDefaults() {
    const fallback = autoTagDefaultsForAiModels()
    const current = normalizeAiModelDefaults(aiModelDefaults.value)
    const customDefaults = extensionModelDefaultKeys.reduce((memo, key) => {
      memo[key] = aiModelDefaultsPersisted.value && Object.prototype.hasOwnProperty.call(current, key)
        ? current[key]
        : fallback[key]
      return memo
    }, {})
    aiModelDefaults.value = customDefaults
    const currentProfiles = normalizeAiProfileDefaults(aiModelProfileDefaults.value, customDefaults)
    aiModelProfileDefaults.value = {
      custom: customDefaults,
      anime: hydrateProfileDefaults('anime', currentProfiles.anime),
      realistic: hydrateProfileDefaults('realistic', currentProfiles.realistic),
    }
  }

  function hydrateProfileDefaults(profileId, current) {
    if (aiModelDefaultsPersisted.value && Object.keys(current || {}).length) {
      return extensionModelDefaultKeys.reduce((memo, key) => {
        memo[key] = current[key] === true
        return memo
      }, {})
    }
    const isAnime = profileId === 'anime'
    return {
      wdEnabled: !isAnime,
      pixaiEnabled: isAnime,
      characterModelEnabled: isAnime,
      clEnabled: false,
      booruLookupEnabled: false,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      ocrEnabled: true,
      whisperEnabled: true,
    }
  }

  function aiModelDefaultsPayload() {
    const profiles = normalizeAiProfileDefaults(aiModelProfileDefaults.value, normalizeAiModelDefaults(aiModelDefaults.value))
    const defaults = normalizeAiModelDefaults(profiles.custom)
    return {
      wdEnabled: defaults.wdEnabled === true,
      pixaiEnabled: defaults.pixaiEnabled === true,
      characterModelEnabled: defaults.characterModelEnabled === true,
      clEnabled: defaults.clEnabled === true,
      booruLookupEnabled: defaults.booruLookupEnabled === true,
      qwenEnabled: defaults.qwenEnabled === true,
      semanticPoliticalEnabled: defaults.qwenEnabled === true,
      ocrEnabled: defaults.ocrEnabled === true,
      whisperEnabled: defaults.whisperEnabled === true,
      profileDefaults: aiDefaultProfileIds.reduce((memo, profileId) => {
        const stack = normalizeAiModelDefaults(profiles[profileId])
        memo[profileId] = {
          wdEnabled: stack.wdEnabled === true,
          pixaiEnabled: stack.pixaiEnabled === true,
          characterModelEnabled: stack.characterModelEnabled === true,
          clEnabled: stack.clEnabled === true,
          booruLookupEnabled: stack.booruLookupEnabled === true,
          qwenEnabled: stack.qwenEnabled === true,
          semanticPoliticalEnabled: stack.qwenEnabled === true,
          ocrEnabled: stack.ocrEnabled === true,
          whisperEnabled: stack.whisperEnabled === true,
        }
        return memo
      }, {}),
    }
  }

  const aiDefaultModels = computed(() => [
    {
      key: 'wdEnabled',
      name: 'WD Tagger',
      description: 'Broad booru-style image and sampled video-frame tags.',
    },
    {
      key: 'pixaiEnabled',
      name: 'PixAI Tagger v0.9',
      description: 'Fast PixAI/Danbooru anime and illustration tags.',
    },
    {
      key: 'characterModelEnabled',
      name: 'Camie Tagger v2',
      description: 'Anime character, copyright/source, artist, and rating tags.',
    },
    {
      key: 'clEnabled',
      name: 'CL Tagger v2',
      description: 'SigLIP2 Danbooru tagger with a 108k-tag character/copyright/general vocabulary.',
    },
    {
      key: 'booruLookupEnabled',
      name: 'Booru series lookup',
      description: 'Look a recognised character up on Danbooru and add its series. Makes a network call; results are cached.',
    },
    {
      key: 'qwenEnabled',
      name: selectedSemanticModel.value?.name || 'Qwen semantic backend',
      description: 'Higher-level semantic analysis using the selected Qwen backend.',
    },
    {
      key: 'ocrEnabled',
      name: 'TrOCR Printed',
      description: 'Visible captions, subtitles, and meme text from images or frames.',
    },
    {
      key: 'whisperEnabled',
      name: 'Whisper Small',
      description: 'Speech, music, and audio transcript signals from videos.',
    },
  ])

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
    const count = extensionModelDefaultKeys.filter((key) => defaults[key] === true).length
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
