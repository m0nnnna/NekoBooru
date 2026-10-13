// Upload popup: the AI model lists. CLAUDE.md's "Adding a new tagger model"
// step 13 lands here - the profile defaults (AI_TAG_PROFILES), the model-key
// array (applyExtensionModelDefaults), the id -> flag map (modelSettingKey)
// and the runtime-requirement helper (dependenciesForModel).
//
// Plain script sharing upload.html's global scope; loaded before upload.js.

const AI_TAG_PROFILES = {
  anime: {
    label: 'Anime / Booru',
    resolve: () => (mediaType === 'video' ? 'anime_video' : 'anime_image'),
  },
  anime_image: {
    label: 'Anime / Booru Image',
    settings: {
      wdEnabled: false,
      pixaiEnabled: true,
      characterModelEnabled: true,
      clEnabled: false,
      ocrEnabled: true,
      whisperEnabled: false,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
    },
  },
  anime_video: {
    label: 'Anime / Booru Video',
    settings: {
      wdEnabled: false,
      pixaiEnabled: true,
      characterModelEnabled: true,
      clEnabled: false,
      ocrEnabled: true,
      whisperEnabled: true,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
      videoMaxFrames: 4,
    },
  },
  realistic_image: {
    label: 'Realistic Image',
    settings: {
      wdEnabled: true,
      pixaiEnabled: false,
      characterModelEnabled: false,
      clEnabled: false,
      ocrEnabled: true,
      whisperEnabled: false,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: 18,
    },
  },
  realistic_video: {
    label: 'Realistic Video',
    settings: {
      wdEnabled: true,
      pixaiEnabled: false,
      characterModelEnabled: false,
      clEnabled: false,
      ocrEnabled: true,
      whisperEnabled: true,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: 20,
      videoMaxFrames: 4,
    },
  },
  realistic: {
    label: 'Realistic',
    resolve: () => (mediaType === 'video' ? 'realistic_video' : 'realistic_image'),
  },
  custom: {
    label: 'Custom',
    settings: null,
  },
}

function applyExtensionModelDefaults(modelDefaults = {}) {
  if (!modelDefaults || typeof modelDefaults !== 'object') return
  if (Object.prototype.hasOwnProperty.call(modelDefaults, 'booruLookupEnabled')) {
    setBooruLookup(modelDefaults.booruLookupEnabled)
  }
  const keys = [
    'wdEnabled',
    'pixaiEnabled',
    'characterModelEnabled',
    'clEnabled',
    'qwenEnabled',
    'semanticPoliticalEnabled',
    'ocrEnabled',
    'whisperEnabled',
  ]
  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(modelDefaults, key)) return
    const enabled = modelDefaults[key] === true
    autoTagModelOverrides[key] = enabled
    autoTagSettings[key] = enabled
  })
  if (
    Object.prototype.hasOwnProperty.call(modelDefaults, 'qwenEnabled') &&
    !Object.prototype.hasOwnProperty.call(modelDefaults, 'semanticPoliticalEnabled')
  ) {
    const enabled = modelDefaults.qwenEnabled === true
    autoTagModelOverrides.semanticPoliticalEnabled = enabled
    autoTagSettings.semanticPoliticalEnabled = enabled
  }
}

function modelSettingKey(id) {
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

function isSemanticModel(model) {
  return model?.role === 'semantic' || ['qwen', 'qwen_gguf_q4', 'qwen_gguf_q8'].includes(model?.id)
}

function visibleAiModels(models) {
  const selectedSemantic = autoTagSettings.semanticModelId || autoTagSavedSettings.semanticModelId || autoTagStatus.semanticModelId || 'qwen'
  return models.filter((model) => !isSemanticModel(model) || model.id === selectedSemantic)
}

function dependenciesForModel(model) {
  if (!model) return []
  if (model.id === 'wd' || model.id === 'pixai' || model.id === 'camie' || model.id === 'cl') return ['onnxruntime', 'numpy', 'pillow']
  if (model.id === 'ocr') return ['transformers', 'torch']
  if (model.id === 'whisper') return ['transformers', 'transformers_pipeline', 'torch']
  if (model.id === 'qwen') return ['transformers', 'torch', 'qwen_vl_utils']
  if (model.id === 'qwen_gguf_q4' || model.id === 'qwen_gguf_q8') return ['llama_cpp']
  return []
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
  }[id] || 'Use this model in the auto-tagging pipeline.'
}

function modelInfoTitle(model) {
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

function profileDefaultStack(profileId) {
  const defaults = extensionUploadDefaults?.modelDefaults?.profileDefaults
  const stack = defaults && typeof defaults === 'object' ? defaults[profileId] : null
  return stack && typeof stack === 'object' ? stack : {}
}

function resolveAiTagProfileId(profileId) {
  const profile = AI_TAG_PROFILES[profileId] || AI_TAG_PROFILES.anime
  return profile.resolve ? profile.resolve() : profileId
}
