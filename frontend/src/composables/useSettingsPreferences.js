// Settings page preferences kept in this browser (which sections are open,
// search-as-you-type options) and the browser extension upload defaults.
import { computed, ref } from 'vue'
import api from '../api/client'

export function useSettingsPreferences() {
  const SETTINGS_SECTIONS_KEY = 'nekobooru.settingsSectionsOpen'
  // Order matches the sections rendered in the template above.
  const settingsSectionIds = [
    'data-storage',
    'search',
    'ai-model-defaults',
    'browser-extension',
    'server',
    'video-downloads-yt-dlp',
    'directory-information',
    'runtime-packaging',
    'app-updates',
    'auto-tagging',
    'restart',
    'account-sharing',
  ]
  const openSections = ref({})
  const SEARCH_PREDICTION_KEY = 'nekobooru.searchPredictionEnabled'
  const NAME_PART_AUTOCOMPLETE_KEY = 'nekobooru.namePartAutocompleteEnabled'
  const searchPredictionEnabled = ref(false)
  const namePartAutocompleteEnabled = ref(false)
  const extensionSettings = ref({
    saveTweetTag: true,
    saveTweetUsername: false,
    saveSourcePageUrl: true,
    saveMediaUrl: false,
    saveSemanticAnalysis: false,
  })
  const savingExtension = ref(false)
  const extensionStatus = ref({
    show: false,
    success: true,
    message: '',
  })

  const openSectionCount = computed(() => settingsSectionIds.filter((id) => openSections.value[id] === true).length)

  function isSectionOpen(id) {
    return openSections.value[id] === true
  }

  function toggleSection(id) {
    openSections.value = { ...openSections.value, [id]: !isSectionOpen(id) }
    persistSectionState()
  }

  function setAllSections(open) {
    openSections.value = settingsSectionIds.reduce((memo, id) => {
      memo[id] = open
      return memo
    }, {})
    persistSectionState()
  }

  function loadSectionState() {
    // Sections start collapsed; the page is long enough that everything expanded
    // buries the section you actually came for.
    let saved = {}
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_SECTIONS_KEY) || '{}')
    } catch {
      saved = {}
    }
    openSections.value = settingsSectionIds.reduce((memo, id) => {
      memo[id] = saved?.[id] === true
      return memo
    }, {})
  }

  function persistSectionState() {
    localStorage.setItem(SETTINGS_SECTIONS_KEY, JSON.stringify(openSections.value))
  }

  function loadSearchPredictionSetting() {
    searchPredictionEnabled.value = localStorage.getItem(SEARCH_PREDICTION_KEY) === 'true'
    namePartAutocompleteEnabled.value = localStorage.getItem(NAME_PART_AUTOCOMPLETE_KEY) === 'true'
  }

  function saveSearchPredictionSetting() {
    localStorage.setItem(SEARCH_PREDICTION_KEY, searchPredictionEnabled.value ? 'true' : 'false')
  }

  function saveNamePartAutocompleteSetting() {
    localStorage.setItem(NAME_PART_AUTOCOMPLETE_KEY, namePartAutocompleteEnabled.value ? 'true' : 'false')
  }

  async function loadExtensionSettings() {
    try {
      const result = await api.getExtensionSettings()
      extensionSettings.value = {
        saveTweetTag: result.saveTweetTag !== false,
        saveTweetUsername: result.saveTweetUsername === true,
        saveSourcePageUrl: result.saveSourcePageUrl !== false,
        saveMediaUrl: result.saveMediaUrl === true,
        saveSemanticAnalysis: result.saveSemanticAnalysis === true,
      }
    } catch (e) {
      console.error('Failed to load extension defaults:', e)
    }
  }

  async function saveExtensionSettings() {
    savingExtension.value = true
    extensionStatus.value.show = false
    try {
      extensionSettings.value = await api.updateExtensionSettings({
        saveTweetTag: extensionSettings.value.saveTweetTag !== false,
        saveTweetUsername: extensionSettings.value.saveTweetUsername === true,
        saveSourcePageUrl: extensionSettings.value.saveSourcePageUrl !== false,
        saveMediaUrl: extensionSettings.value.saveMediaUrl === true,
        saveSemanticAnalysis: extensionSettings.value.saveSemanticAnalysis === true,
      })
      extensionStatus.value = {
        show: true,
        success: true,
        message: 'Extension defaults saved.',
      }
    } catch (e) {
      extensionStatus.value = {
        show: true,
        success: false,
        message: 'Failed to save extension defaults: ' + e.message,
      }
    } finally {
      savingExtension.value = false
    }
  }
  return {
    settingsSectionIds,
    openSections,
    openSectionCount,
    isSectionOpen,
    toggleSection,
    setAllSections,
    loadSectionState,
    searchPredictionEnabled,
    namePartAutocompleteEnabled,
    loadSearchPredictionSetting,
    saveSearchPredictionSetting,
    saveNamePartAutocompleteSetting,
    extensionSettings,
    savingExtension,
    extensionStatus,
    loadExtensionSettings,
    saveExtensionSettings,
  }
}
