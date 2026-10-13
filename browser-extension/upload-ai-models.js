// Upload popup: the AI model registry and the helpers built on it - the
// Anime / Realistic profiles, the flag keys, the id -> flag map and the
// runtime packages each model needs.
//
// The server owns the registry (GET /api/auto-tags/registry, from
// backend/app/services/auto_tagger/core.py); loadAiModelRegistry() fetches it
// before the AI controls render. The copy below is only the fallback for a
// server that cannot be reached or predates the endpoint, and
// tests/test_auto_tags_api_models.py fails when it drifts from what the server
// serves. Adding a tagger model needs no change in this file beyond that copy.
//
// Plain script sharing upload.html's global scope; loaded before upload.js.

const AI_MODEL_REGISTRY_FALLBACK = /* registry:start */{
  "flags": [
    {
      "key": "wdEnabled",
      "name": "WD Tagger",
      "label": "WD",
      "description": "Broad booru-style image and sampled video-frame tags.",
      "defaultEnabled": true
    },
    {
      "key": "pixaiEnabled",
      "name": "PixAI Tagger v0.9",
      "label": "PixAI",
      "description": "Fast PixAI/Danbooru anime and illustration tags.",
      "defaultEnabled": false
    },
    {
      "key": "characterModelEnabled",
      "name": "Camie Tagger v2",
      "label": "Camie",
      "description": "Anime character, copyright/source, artist, and rating tags.",
      "defaultEnabled": false
    },
    {
      "key": "clEnabled",
      "name": "CL Tagger v2",
      "label": "CL",
      "description": "SigLIP2 Danbooru tagger with a 108k-tag character/copyright/general vocabulary.",
      "defaultEnabled": false
    },
    {
      "key": "booruLookupEnabled",
      "name": "Booru series lookup",
      "label": "Booru lookup",
      "lookup": true,
      "description": "Look a recognised character up on Danbooru and add its series. Makes a network call; results are cached.",
      "defaultEnabled": false
    },
    {
      "key": "qwenEnabled",
      "name": "Qwen semantic backend",
      "label": "Qwen",
      "description": "Higher-level semantic analysis using the selected Qwen backend.",
      "defaultEnabled": false
    },
    {
      "key": "ocrEnabled",
      "name": "TrOCR Printed",
      "label": "OCR",
      "description": "Visible captions, subtitles, and meme text from images or frames.",
      "defaultEnabled": false
    },
    {
      "key": "whisperEnabled",
      "name": "Whisper Small",
      "label": "audio",
      "videoOnly": true,
      "description": "Speech, music, and audio transcript signals from videos.",
      "defaultEnabled": false
    }
  ],
  "flagKeys": [
    "wdEnabled",
    "pixaiEnabled",
    "characterModelEnabled",
    "clEnabled",
    "booruLookupEnabled",
    "qwenEnabled",
    "ocrEnabled",
    "whisperEnabled",
    "semanticPoliticalEnabled"
  ],
  "mirroredFlags": {
    "semanticPoliticalEnabled": "qwenEnabled"
  },
  "models": [
    {
      "id": "wd",
      "name": "WD Tagger",
      "repoId": "SmilingWolf/wd-eva02-large-tagger-v3",
      "purpose": "Booru-style image and sampled video-frame tags",
      "downloadSize": "~1.2 GB",
      "vramRequirement": "~0.5-1.5 GB",
      "settingKey": "wdEnabled",
      "pipelineLabel": "Enable by default for booru tags",
      "pipelineDescription": "Runs on images and sampled video frames. Best baseline for visual library tags.",
      "runtimePackages": [
        "onnxruntime",
        "numpy",
        "pillow"
      ]
    },
    {
      "id": "pixai",
      "name": "PixAI Tagger v0.9",
      "repoId": "deepghs/pixai-tagger-v0.9-onnx",
      "purpose": "Fast Danbooru-style anime/illustration tags from PixAI Tagger v0.9",
      "downloadSize": "~1.3 GB",
      "vramRequirement": "~0.5-1.5 GB",
      "settingKey": "pixaiEnabled",
      "pipelineLabel": "Enable by default for PixAI anime tags",
      "pipelineDescription": "Runs fast PixAI/Danbooru anime tags on images and sampled video frames.",
      "runtimePackages": [
        "onnxruntime",
        "numpy",
        "pillow"
      ]
    },
    {
      "id": "camie",
      "name": "Camie Tagger v2",
      "repoId": "Camais03/camie-tagger-v2",
      "purpose": "Anime character, copyright, artist, rating, and broad tag coverage",
      "downloadSize": "~1-3 GB",
      "vramRequirement": "~0.5-2 GB",
      "settingKey": "characterModelEnabled",
      "pipelineLabel": "Enable by default for character/source tags",
      "pipelineDescription": "Adds anime characters, copyright/source tags, artist tags, and rating evidence.",
      "runtimePackages": [
        "onnxruntime",
        "numpy",
        "pillow"
      ]
    },
    {
      "id": "cl",
      "name": "CL Tagger v2",
      "repoId": "cella110n/cl_tagger_v2",
      "purpose": "SigLIP2 Danbooru tagger with a 108k-tag character/copyright/general vocabulary",
      "downloadSize": "~2.3 GB",
      "vramRequirement": "~2-3 GB",
      "settingKey": "clEnabled",
      "pipelineLabel": "Enable by default for CL Tagger v2 tags",
      "pipelineDescription": "SigLIP2 tagger with a 108k-tag Danbooru vocabulary. Gated model: accept its licence on Hugging Face and save a token before downloading.",
      "runtimePackages": [
        "onnxruntime",
        "numpy",
        "pillow"
      ]
    },
    {
      "id": "qwen",
      "name": "Qwen2.5-VL 7B Instruct",
      "repoId": "Qwen/Qwen2.5-VL-7B-Instruct",
      "purpose": "Semantic video/edit understanding, political context, and natural-language evidence",
      "downloadSize": "~15-17 GB",
      "vramRequirement": "~14-18 GB fp16, 24 GB comfortable",
      "role": "semantic",
      "settingKey": "qwenEnabled",
      "pipelineLabel": "Enable by default for semantic tags",
      "pipelineDescription": "Uses image plus OCR/transcript context for higher-level edit and scene meaning.",
      "runtimePackages": [
        "transformers",
        "torch",
        "qwen_vl_utils"
      ]
    },
    {
      "id": "qwen_gguf_q4",
      "name": "Qwen3-VL 8B GGUF Q4",
      "repoId": "Qwen/Qwen3-VL-8B-Instruct-GGUF",
      "purpose": "Fast local semantic image/video-frame understanding through llama.cpp GGUF",
      "downloadSize": "~6.4 GB",
      "vramRequirement": "~6-8 GB, 8-12 GB comfortable",
      "role": "semantic",
      "settingKey": "qwenEnabled",
      "pipelineLabel": "Enable by default for semantic tags",
      "pipelineDescription": "Uses Qwen3-VL GGUF Q4 through llama.cpp for faster low-memory semantic tags.",
      "runtimePackages": [
        "llama_cpp"
      ]
    },
    {
      "id": "qwen_gguf_q8",
      "name": "Qwen3-VL 8B GGUF Q8",
      "repoId": "Qwen/Qwen3-VL-8B-Instruct-GGUF",
      "purpose": "Higher-quality local semantic image/video-frame understanding through llama.cpp GGUF",
      "downloadSize": "~10.0 GB",
      "vramRequirement": "~10-12 GB, 12-16 GB comfortable",
      "role": "semantic",
      "settingKey": "qwenEnabled",
      "pipelineLabel": "Enable by default for semantic tags",
      "pipelineDescription": "Uses Qwen3-VL GGUF Q8 through llama.cpp for higher-quality semantic tags.",
      "runtimePackages": [
        "llama_cpp"
      ]
    },
    {
      "id": "ocr",
      "name": "TrOCR Printed",
      "repoId": "microsoft/trocr-base-printed",
      "purpose": "Text extraction from meme/edit frames and subtitles",
      "downloadSize": "~1.3 GB",
      "vramRequirement": "~1-2 GB",
      "settingKey": "ocrEnabled",
      "pipelineLabel": "Enable by default for text extraction",
      "pipelineDescription": "Reads visible captions, subtitles, and meme text from representative frames.",
      "runtimePackages": [
        "transformers",
        "torch"
      ]
    },
    {
      "id": "whisper",
      "name": "Whisper Small",
      "repoId": "openai/whisper-small",
      "purpose": "Speech/audio transcript signals for AMVs and edits",
      "downloadSize": "~1 GB",
      "vramRequirement": "~1-2 GB",
      "settingKey": "whisperEnabled",
      "pipelineLabel": "Enable by default for audio transcripts",
      "pipelineDescription": "Extracts speech from video audio for AMVs, edits, narration, and spoken context.",
      "runtimePackages": [
        "transformers",
        "transformers_pipeline",
        "torch"
      ]
    }
  ],
  "profiles": {
    "anime": {
      "models": {
        "wdEnabled": false,
        "pixaiEnabled": true,
        "characterModelEnabled": true,
        "clEnabled": false,
        "booruLookupEnabled": false,
        "qwenEnabled": false,
        "ocrEnabled": true,
        "whisperEnabled": true,
        "semanticPoliticalEnabled": false
      },
      "tuning": {
        "generalThreshold": 0.35,
        "characterThreshold": 0.45,
        "maxTags": 40,
        "videoMaxTags": 40,
        "videoMaxFrames": 4
      },
      "qwenReplaces": []
    },
    "realistic": {
      "models": {
        "wdEnabled": true,
        "pixaiEnabled": false,
        "characterModelEnabled": false,
        "clEnabled": false,
        "booruLookupEnabled": false,
        "qwenEnabled": false,
        "ocrEnabled": true,
        "whisperEnabled": true,
        "semanticPoliticalEnabled": false
      },
      "tuning": {
        "generalThreshold": 0.5,
        "characterThreshold": 0.6,
        "maxTags": 18,
        "videoMaxTags": 20,
        "videoMaxFrames": 4
      },
      "qwenReplaces": [
        "wdEnabled"
      ]
    }
  }
}/* registry:end */

let aiModelRegistry = AI_MODEL_REGISTRY_FALLBACK

async function loadAiModelRegistry() {
  try {
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/auto-tags/registry`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    if (payload && Array.isArray(payload.flags) && payload.profiles) aiModelRegistry = payload
  } catch (e) {
    // Keep the fallback: an older server, or one that is not up yet.
  }
  return aiModelRegistry
}

const AI_TAG_PROFILE_LABELS = {
  anime: 'Anime / Booru',
  anime_image: 'Anime / Booru Image',
  anime_video: 'Anime / Booru Video',
  realistic: 'Realistic',
  realistic_image: 'Realistic Image',
  realistic_video: 'Realistic Video',
  custom: 'Custom',
}

// A profile's built-in stack and thresholds for one media type. Booru lookup
// is a setting, not a model, so it stays out (see booruLookupEnabled in upload.js).
function aiTagProfileSettings(rootProfileId, isVideo) {
  const profile = aiModelRegistry.profiles?.[rootProfileId]
  if (!profile) return null
  const settings = {}
  aiModelRegistry.flags.forEach((flag) => {
    if (flag.lookup) return
    settings[flag.key] = profile.models?.[flag.key] === true && (!flag.videoOnly || isVideo)
  })
  Object.entries(aiModelRegistry.mirroredFlags || {}).forEach(([mirror, source]) => {
    settings[mirror] = settings[source] === true
  })
  const tuning = profile.tuning || {}
  settings.generalThreshold = tuning.generalThreshold
  settings.characterThreshold = tuning.characterThreshold
  settings.maxTags = isVideo ? tuning.videoMaxTags : tuning.maxTags
  if (isVideo) settings.videoMaxFrames = tuning.videoMaxFrames
  return settings
}

// anime / realistic resolve to their image or video variant; custom runs the
// checkboxes as they are.
function aiTagProfile(profileId) {
  if (profileId === 'anime' || profileId === 'realistic') {
    return {
      label: AI_TAG_PROFILE_LABELS[profileId],
      resolve: () => `${profileId}_${mediaType === 'video' ? 'video' : 'image'}`,
    }
  }
  const variant = /^(anime|realistic)_(image|video)$/.exec(profileId || '')
  if (variant) {
    return { label: AI_TAG_PROFILE_LABELS[profileId], settings: aiTagProfileSettings(variant[1], variant[2] === 'video') }
  }
  if (profileId === 'custom') return { label: AI_TAG_PROFILE_LABELS.custom, settings: null }
  return null
}

// Flags a profile turns off when Qwen runs (Realistic: Qwen replaces WD).
function aiTagProfileQwenReplaces(rootProfileId) {
  return aiModelRegistry.profiles?.[rootProfileId]?.qwenReplaces || []
}

function applyExtensionModelDefaults(modelDefaults = {}) {
  if (!modelDefaults || typeof modelDefaults !== 'object') return
  if (Object.prototype.hasOwnProperty.call(modelDefaults, 'booruLookupEnabled')) {
    setBooruLookup(modelDefaults.booruLookupEnabled)
  }
  const keys = aiModelRegistry.flagKeys.filter((key) => key !== 'booruLookupEnabled')
  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(modelDefaults, key)) return
    const enabled = modelDefaults[key] === true
    autoTagModelOverrides[key] = enabled
    autoTagSettings[key] = enabled
  })
  Object.entries(aiModelRegistry.mirroredFlags || {}).forEach(([mirror, source]) => {
    if (
      Object.prototype.hasOwnProperty.call(modelDefaults, source) &&
      !Object.prototype.hasOwnProperty.call(modelDefaults, mirror)
    ) {
      const enabled = modelDefaults[source] === true
      autoTagModelOverrides[mirror] = enabled
      autoTagSettings[mirror] = enabled
    }
  })
}

function registryModel(id) {
  return aiModelRegistry.models.find((model) => model.id === id)
}

function modelSettingKey(id) {
  return registryModel(id)?.settingKey || `${id}Enabled`
}

function isSemanticModel(model) {
  return model?.role === 'semantic' || registryModel(model?.id)?.role === 'semantic'
}

function visibleAiModels(models) {
  const selectedSemantic = autoTagSettings.semanticModelId || autoTagSavedSettings.semanticModelId || autoTagStatus.semanticModelId || 'qwen'
  return models.filter((model) => !isSemanticModel(model) || model.id === selectedSemantic)
}

function dependenciesForModel(model) {
  if (!model) return []
  return registryModel(model.id)?.runtimePackages || model.runtimePackages || []
}

function modelPipelineDescription(id) {
  return registryModel(id)?.pipelineDescription || 'Use this model in the auto-tagging pipeline.'
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
  const profile = aiTagProfile(profileId) || aiTagProfile('anime')
  return profile.resolve ? profile.resolve() : profileId
}
