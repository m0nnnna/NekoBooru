// The AI model registry, served by GET /api/auto-tags/registry and owned by
// backend/app/services/auto_tagger/core.py (model_registry_payload). The
// Settings, post, upload and batch views derive their model lists, flag keys,
// per-model labels and runtime packages, and the Anime / Realistic profile
// stacks from it; none of them keeps a copy. Adding a tagger model needs no
// change here.
import { ref } from 'vue'
import api from '../api/client'

const EMPTY_REGISTRY = { flags: [], flagKeys: [], mirroredFlags: {}, models: [], profiles: {} }

export const aiModelRegistry = ref(EMPTY_REGISTRY)
export const aiProfileIds = ['custom', 'anime', 'realistic']

let pending = null

// Loads once per page; every view awaits it before normalising saved defaults.
export function loadAiModelRegistry() {
  if (!pending) {
    pending = Promise.resolve()
      .then(() => api.getAutoTagRegistry())
      .then((payload) => {
        aiModelRegistry.value = { ...EMPTY_REGISTRY, ...(payload || {}) }
        return aiModelRegistry.value
      })
      .catch((e) => {
        pending = null
        console.error('Failed to load the AI model registry:', e)
        return aiModelRegistry.value
      })
  }
  return pending
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

// The default-stack rows in display order. Lookup rows (booru lookup) are
// settings, not models; pass { models: true } to leave them out.
export function modelFlags({ models = false } = {}) {
  return aiModelRegistry.value.flags.filter((flag) => !models || !flag.lookup)
}

export function normalizeAiModelDefaults(raw = {}) {
  const defaults = raw && typeof raw === 'object' ? raw : {}
  const normalized = {}
  for (const key of aiModelRegistry.value.flagKeys) {
    if (has(defaults, key)) normalized[key] = defaults[key] === true
  }
  for (const [mirror, source] of Object.entries(aiModelRegistry.value.mirroredFlags)) {
    if (has(normalized, source) && !has(normalized, mirror)) normalized[mirror] = normalized[source]
  }
  return normalized
}

// Every flag as a boolean, with mirrored flags following their source.
export function completeModelStack(stack = {}) {
  const complete = {}
  for (const flag of aiModelRegistry.value.flags) complete[flag.key] = stack?.[flag.key] === true
  for (const [mirror, source] of Object.entries(aiModelRegistry.value.mirroredFlags)) {
    complete[mirror] = complete[source]
  }
  return complete
}

export function builtInProfileStack(profileId) {
  return { ...(aiModelRegistry.value.profiles[profileId]?.models || {}) }
}

// Saved profile stacks over the built-in ones; Custom falls back to `fallback`.
export function normalizeAiProfileDefaults(raw = {}, fallback = {}) {
  const profiles = raw && typeof raw === 'object' ? raw : {}
  return aiProfileIds.reduce((memo, profileId) => {
    memo[profileId] = {
      ...(profileId === 'custom' ? fallback : builtInProfileStack(profileId)),
      ...normalizeAiModelDefaults(profiles[profileId] || {}),
    }
    return memo
  }, {})
}

// The settings an Anime / Realistic run sends: the profile's stack, Qwen when
// the stack or the caller asks for it, and the profile's thresholds. Returns
// null for Custom, which runs the checkboxes as they are.
export function profileRunSettings(profileId, { isVideo = false, profileStack = {}, qwenRequested = false, savedSettings = {} } = {}) {
  const profile = aiModelRegistry.value.profiles[profileId]
  if (!profile) return null
  const stack = { ...profile.models, ...normalizeAiModelDefaults(profileStack) }
  const useQwen = stack.qwenEnabled === true || qwenRequested === true
  const settings = completeModelStack({ ...stack, qwenEnabled: useQwen })
  for (const flag of aiModelRegistry.value.flags) {
    if (flag.videoOnly) settings[flag.key] = isVideo && settings[flag.key]
  }
  if (useQwen) {
    for (const key of profile.qwenReplaces || []) settings[key] = false
  }
  const tuning = profile.tuning || {}
  Object.assign(settings, {
    semanticModelId: savedSettings.semanticModelId || 'qwen',
    generalThreshold: tuning.generalThreshold,
    characterThreshold: tuning.characterThreshold,
    maxTags: isVideo ? tuning.videoMaxTags : tuning.maxTags,
  })
  if (isVideo) {
    Object.assign(settings, {
      videoMaxFrames: tuning.videoMaxFrames,
      qwenVideoUseFps: savedSettings.qwenVideoUseFps === true,
      qwenVideoMaxFrames: savedSettings.qwenVideoMaxFrames || 20,
    })
  }
  return settings
}

function registryModel(id) {
  return aiModelRegistry.value.models.find((model) => model.id === id)
}

export function modelSettingKey(id) {
  return registryModel(id)?.settingKey || `${id}Enabled`
}

export function isSemanticModel(model) {
  return model?.role === 'semantic' || registryModel(model?.id)?.role === 'semantic'
}

export function modelPipelineLabel(id) {
  return registryModel(id)?.pipelineLabel || 'Enable by default'
}

export function modelPipelineDescription(id, fallback = 'Use this model in the auto-tagging pipeline.') {
  return registryModel(id)?.pipelineDescription || fallback
}

export function dependenciesForModel(model) {
  if (!model) return []
  return registryModel(model.id)?.runtimePackages || model.runtimePackages || []
}

export function modelInfoTitle(model, fallbackDescription) {
  return [
    model.name,
    model.purpose,
    modelPipelineDescription(model.id, fallbackDescription),
    `Download size: ${model.downloadSize || 'Unknown'}`,
    `VRAM: ${model.vramRequirement || 'Unknown'}`,
    `Runtime: ${model.runtimeAvailable ? 'ready' : 'missing'}`,
    `Memory: ${model.loaded ? 'loaded' : 'not loaded'}`,
    model.providers?.length ? `Provider: ${model.providers.join(', ')}` : null,
  ].filter(Boolean).join('\n')
}

// The Anime / Realistic / Custom buttons the post and upload pages show.
export const AI_PROFILE_BUTTONS = [
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
]
