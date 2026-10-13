// The post page's AI model helpers. The model list, flag keys, runtime
// packages and Anime / Realistic stacks come from the shared registry
// (useAiModelRegistry.js); this file only adds the post page's wording.
import {
  AI_PROFILE_BUTTONS,
  aiModelRegistry,
  dependenciesForModel,
  isSemanticModel,
  modelInfoTitle,
  modelSettingKey,
  normalizeAiModelDefaults,
  normalizeAiProfileDefaults,
  profileRunSettings,
} from './useAiModelRegistry'

export {
  dependenciesForModel,
  isSemanticModel,
  modelSettingKey,
  normalizeAiModelDefaults,
  normalizeAiProfileDefaults,
}

export const autoTagProfiles = [
  ...AI_PROFILE_BUTTONS,
  {
    id: 'custom',
    label: 'Custom',
    tooltip: 'Runs exactly the model checkboxes currently selected below. This does not change your saved defaults.',
  },
]

// Rows for the model picker until /status reports the live ones.
export function defaultAutoTagModels() {
  return aiModelRegistry.value.models
}

export function postModelInfoTitle(model) {
  return modelInfoTitle(model, 'Use this model in the per-post auto-tagging pipeline.')
}

// Settings a preview profile switches on. Custom returns null: it runs the
// checkboxes as they are.
export function autoTagProfileSettings(profileId, { isVideo, savedProfileDefaults, postSettings, savedSettings }) {
  if (profileId === 'custom') return null
  return profileRunSettings(profileId, {
    isVideo,
    profileStack: savedProfileDefaults?.[profileId] || {},
    qwenRequested: postSettings?.qwenEnabled === true,
    savedSettings: savedSettings || {},
  })
}
