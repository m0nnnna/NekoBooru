// The post page's AI model lists: the default model rows, the preview
// profiles, the model-id -> setting-key map, the pipeline descriptions, the
// runtime-package requirements, and the anime / realistic profile defaults.
// This is the Post view's copy of the model lists (CLAUDE.md "Adding a new
// tagger model", step 11).

export const DEFAULT_AUTO_TAG_MODELS = [
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
    id: 'cl',
    name: 'CL Tagger v2',
    repoId: 'cella110n/cl_tagger_v2',
    purpose: 'SigLIP2 Danbooru tagger with a 108k-tag character/copyright/general vocabulary',
    downloadSize: '~2.3 GB',
    vramRequirement: '~2-3 GB',
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

export const autoTagProfiles = [
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

export function isSemanticModel(model) {
  return model?.role === 'semantic' || ['qwen', 'qwen_gguf_q4', 'qwen_gguf_q8'].includes(model?.id)
}

export function modelPipelineDescription(id) {
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

export function postModelInfoTitle(model) {
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

export function dependenciesForModel(model) {
  if (!model) return []
  if (model.id === 'wd' || model.id === 'pixai' || model.id === 'camie' || model.id === 'cl') return ['onnxruntime', 'numpy', 'pillow']
  if (model.id === 'ocr') return ['transformers', 'torch']
  if (model.id === 'whisper') return ['transformers', 'transformers_pipeline', 'torch']
  if (model.id === 'qwen') return ['transformers', 'torch', 'qwen_vl_utils']
  if (model.id === 'qwen_gguf_q4' || model.id === 'qwen_gguf_q8') return ['llama_cpp']
  return []
}

export function normalizeAiModelDefaults(raw = {}) {
  const defaults = raw && typeof raw === 'object' ? raw : {}
  const normalized = {}
  for (const key of ['wdEnabled', 'pixaiEnabled', 'characterModelEnabled', 'clEnabled', 'qwenEnabled', 'semanticPoliticalEnabled', 'ocrEnabled', 'whisperEnabled']) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      normalized[key] = defaults[key] === true
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'qwenEnabled') && !Object.prototype.hasOwnProperty.call(normalized, 'semanticPoliticalEnabled')) {
    normalized.semanticPoliticalEnabled = normalized.qwenEnabled
  }
  return normalized
}

export function normalizeAiProfileDefaults(raw = {}, fallback = {}) {
  const profiles = raw && typeof raw === 'object' ? raw : {}
  const defaults = {
    custom: fallback,
    anime: { wdEnabled: false, pixaiEnabled: true, characterModelEnabled: true, clEnabled: false, qwenEnabled: false, semanticPoliticalEnabled: false, ocrEnabled: true, whisperEnabled: true },
    realistic: { wdEnabled: true, pixaiEnabled: false, characterModelEnabled: false, clEnabled: false, qwenEnabled: false, semanticPoliticalEnabled: false, ocrEnabled: true, whisperEnabled: true },
  }
  return ['custom', 'anime', 'realistic'].reduce((memo, profileId) => {
    memo[profileId] = {
      ...defaults[profileId],
      ...normalizeAiModelDefaults(profiles[profileId] || {}),
    }
    return memo
  }, {})
}
// Settings a preview profile switches on. Custom returns null: it runs the
// checkboxes as they are.
export function autoTagProfileSettings(profileId, { isVideo, savedProfileDefaults, postSettings, savedSettings }) {
  if (profileId === 'custom') return null
  const profileDefaults = savedProfileDefaults?.[profileId] || {}
  const useSemanticQwen = [
    profileDefaults.qwenEnabled,
    postSettings.qwenEnabled,
  ].some(Boolean)
  if (profileId === 'anime') {
    return {
      wdEnabled: profileDefaults.wdEnabled === true,
      pixaiEnabled: profileDefaults.pixaiEnabled === true,
      characterModelEnabled: profileDefaults.characterModelEnabled !== false,
      clEnabled: profileDefaults.clEnabled === true,
      ocrEnabled: profileDefaults.ocrEnabled !== false,
      whisperEnabled: isVideo && profileDefaults.whisperEnabled !== false,
      qwenEnabled: useSemanticQwen,
      semanticPoliticalEnabled: useSemanticQwen,
      semanticModelId: savedSettings.semanticModelId || 'qwen',
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
      ...(isVideo ? {
        videoMaxFrames: 4,
        qwenVideoUseFps: savedSettings.qwenVideoUseFps === true,
        qwenVideoMaxFrames: savedSettings.qwenVideoMaxFrames || 20,
      } : {}),
    }
  }
  if (profileId === 'realistic') {
    return {
      wdEnabled: useSemanticQwen ? false : profileDefaults.wdEnabled !== false,
      pixaiEnabled: profileDefaults.pixaiEnabled === true,
      characterModelEnabled: profileDefaults.characterModelEnabled === true,
      clEnabled: profileDefaults.clEnabled === true,
      ocrEnabled: profileDefaults.ocrEnabled !== false,
      whisperEnabled: isVideo && profileDefaults.whisperEnabled !== false,
      qwenEnabled: useSemanticQwen,
      semanticPoliticalEnabled: useSemanticQwen,
      semanticModelId: savedSettings.semanticModelId || 'qwen',
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: isVideo ? 20 : 18,
      ...(isVideo ? {
        videoMaxFrames: 4,
        qwenVideoUseFps: savedSettings.qwenVideoUseFps === true,
        qwenVideoMaxFrames: savedSettings.qwenVideoMaxFrames || 20,
      } : {}),
    }
  }
  return null
}
