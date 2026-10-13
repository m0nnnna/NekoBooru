// Upload-page AI tagging: the per-upload preview profiles, the model-key
// list, the anime / realistic profile defaults, and the settings each
// preview run sends. This is the Upload view's copy of the model lists
// (CLAUDE.md "Adding a new tagger model", step 12).
import { ref } from 'vue'
import api from '../api/client'
import { isVideoUpload } from './useUploadQueue'

export const aiProfiles = [
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
    tooltip: 'Runs your saved auto-tag defaults from Settings for this upload preview.',
  },
]

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
export function useUploadAiProfiles() {
  const autoTagUploads = ref(false)
  const aiEnabled = ref(false)
  const autoTagSettings = ref({})
  const savedAutoTagSettings = ref({})
  const savedAutoTagProfileDefaults = ref({ custom: {}, anime: {}, realistic: {} })

  async function loadAiEnabled() {
    try {
      const [settings, status, defaultsResult] = await Promise.all([
        api.getAutoTagSettings(),
        api.getAutoTagStatus(),
        api.getAiModelDefaults(),
      ])
      const modelDefaults = normalizeAiModelDefaults(defaultsResult?.modelDefaults)
      savedAutoTagProfileDefaults.value = normalizeAiProfileDefaults(defaultsResult?.modelDefaults?.profileDefaults, modelDefaults)
      autoTagSettings.value = {
        ...settings,
        wdEnabled: settings.wdEnabled !== false,
        semanticModelId: settings.semanticModelId || 'qwen',
        ...modelDefaults,
      }
      if (Object.prototype.hasOwnProperty.call(modelDefaults, 'qwenEnabled')) {
        autoTagSettings.value.semanticPoliticalEnabled = modelDefaults.semanticPoliticalEnabled ?? modelDefaults.qwenEnabled
      }
      savedAutoTagSettings.value = { ...autoTagSettings.value }
      aiEnabled.value = Boolean(status?.enabled)
    } catch (e) {
      aiEnabled.value = false
    }
    // Never request tagging when AI is off, even if a stale value lingers.
    if (!aiEnabled.value) autoTagUploads.value = false
  }

  async function ensureUploadToken(upload) {
    if (upload.token) return upload.token
    upload.aiStatus = 'Uploading temporary file for AI preview...'
    const result = await api.uploadFile(upload.file)
    upload.token = result.token
    return upload.token
  }

  async function previewUploadAiTags(upload, profileId = 'custom') {
    upload.aiTagging = true
    upload.aiProfile = profileId
    upload.aiError = false
    upload.aiStatus = 'Preparing AI preview...'
    try {
      const token = await ensureUploadToken(upload)
      upload.aiStatus = 'Analyzing upload with AI...'
      const suggestion = await api.previewUploadAutoTags(token, {
        tags: upload.tags,
        safety: upload.safety,
        settings: uploadAiRunSettings(upload, profileId),
      })
      if (suggestion.error) throw new Error(suggestion.error)
      upload.tags = suggestion.suggestedTags || upload.tags
      upload.safety = suggestion.suggestedSafety || upload.safety || 'safe'
      upload.aiPreviewed = true
      upload.aiStatus = `AI tags applied: ${profileLabel(profileId)}`
    } catch (e) {
      upload.aiError = true
      upload.aiStatus = `AI tag failed: ${e.message}`
    } finally {
      upload.aiTagging = false
    }
  }

  function uploadAiRunSettings(upload, profileId) {
    const profileSettings = uploadAiProfileSettings(upload, profileId)
    const qwenEnabled = profileSettings.qwenEnabled === true || (profileId === 'custom' && autoTagSettings.value.qwenEnabled === true)
    return {
      ...autoTagSettings.value,
      ...profileSettings,
      qwenEnabled,
      semanticPoliticalEnabled: qwenEnabled,
      enabled: true,
    }
  }

  function uploadAiProfileSettings(upload, profileId) {
    if (profileId === 'custom') return {}
    const isVideo = isVideoUpload(upload)
    const profileDefaults = savedAutoTagProfileDefaults.value?.[profileId] || {}
    const useSemanticQwen = [
      profileDefaults.qwenEnabled,
      autoTagSettings.value.qwenEnabled,
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
        semanticModelId: savedAutoTagSettings.value.semanticModelId || 'qwen',
        generalThreshold: 0.35,
        characterThreshold: 0.45,
        maxTags: 40,
        ...(isVideo ? {
          videoMaxFrames: 4,
          qwenVideoUseFps: savedAutoTagSettings.value.qwenVideoUseFps === true,
          qwenVideoMaxFrames: savedAutoTagSettings.value.qwenVideoMaxFrames || 20,
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
        semanticModelId: savedAutoTagSettings.value.semanticModelId || 'qwen',
        generalThreshold: 0.5,
        characterThreshold: 0.6,
        maxTags: isVideo ? 20 : 18,
        ...(isVideo ? {
          videoMaxFrames: 4,
          qwenVideoUseFps: savedAutoTagSettings.value.qwenVideoUseFps === true,
          qwenVideoMaxFrames: savedAutoTagSettings.value.qwenVideoMaxFrames || 20,
        } : {}),
      }
    }
    return {}
  }

  function profileLabel(profileId) {
    return aiProfiles.find((profile) => profile.id === profileId)?.label || 'Custom'
  }
  return {
    aiProfiles,
    autoTagUploads,
    aiEnabled,
    autoTagSettings,
    savedAutoTagSettings,
    savedAutoTagProfileDefaults,
    loadAiEnabled,
    previewUploadAiTags,
    uploadAiRunSettings,
    uploadAiProfileSettings,
    profileLabel,
  }
}
