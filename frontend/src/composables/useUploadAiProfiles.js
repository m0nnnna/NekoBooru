// Upload-page AI tagging: the per-upload preview profiles and the settings
// each preview run sends. The model keys and the Anime / Realistic stacks come
// from the shared registry (useAiModelRegistry.js).
import { ref } from 'vue'
import api from '../api/client'
import { isVideoUpload } from './useUploadQueue'
import {
  AI_PROFILE_BUTTONS,
  loadAiModelRegistry,
  normalizeAiModelDefaults,
  normalizeAiProfileDefaults,
  profileRunSettings,
} from './useAiModelRegistry'

export const aiProfiles = [
  ...AI_PROFILE_BUTTONS,
  {
    id: 'custom',
    label: 'Custom',
    tooltip: 'Runs your saved auto-tag defaults from Settings for this upload preview.',
  },
]

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
        loadAiModelRegistry(),
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
    return profileRunSettings(profileId, {
      isVideo: isVideoUpload(upload),
      profileStack: savedAutoTagProfileDefaults.value?.[profileId] || {},
      qwenRequested: autoTagSettings.value.qwenEnabled === true,
      savedSettings: savedAutoTagSettings.value,
    }) || {}
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
