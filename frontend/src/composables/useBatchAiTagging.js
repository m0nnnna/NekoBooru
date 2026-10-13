import { ref, computed } from 'vue'
import { api } from '../api/client'
import {
  loadAiModelRegistry,
  modelFlags,
  normalizeAiModelDefaults,
  normalizeAiProfileDefaults,
  profileRunSettings,
} from './useAiModelRegistry'

// "AI Tag Selected": which model profile/stack to run on the selection and
// the settings sent with the backend auto-tag job.

const defaultSemanticPrompt = [
  'Return compact JSON only with keys: tags, safety, rationale.',
  'Use snake_case tags only.',
  '',
  'Semantic description:',
  '- The rationale should describe the visible image or frame collection in detail, including clothing garments, describe the pose, setting, text, audio/transcript evidence, and why semantic/context tags were included.',
  '',
  'Tags in priority order:',
  '- Return 6-28 useful searchable tags supported by the image, frame, OCR, transcript, or source page.',
  '- Start with directly visible tags: media type, pose, subject count, male/female/girl/boy, setting, objects, actions, expression, hair color, eye color, framing, text/audio presence, and meme/edit format.',
  '- Decompose clothing into specific garments and attributes. Name the garment type separately from pattern or theme. Example cow_print_outfit, bikini, swimsuit, would all be included.',
  '- Do not confuse animal ears or horns for clothing, or horns for ears. Tag what is visibly present, such as animal_ears, cow_horns, white_horns, tail, or cow_tail.',
  '- Add frequent or matching primary colors for the scene or clothing, hair color, eye color, standout accessories, exact pose, and anything visually distinctive.',
  '- Include screenshot, photo, video, image, or gif when they fit.',
  '- Add semantic/context tags only when supported: political_edit, meme_edit, amv, music_video, captioned, protest, politician, propaganda, music, edit, has_text, text_overlay, has_speech, swastika, sonnenrad, black_sun, national_socialism, hammer_and_sickle, communism.',
].join('\n')

// The batch panel's model checkboxes: every registry model flag (booru lookup
// is a setting, not a model, and stays out).
function batchModelOptions() {
  return modelFlags({ models: true }).map((flag) => ({
    key: flag.key,
    label: flag.key === 'qwenEnabled' ? 'Qwen Semantic' : flag.name,
    help: flag.description,
  }))
}

function defaultBatchAiSettings() {
  return {
    enabled: true,
    wdEnabled: true,
    characterModelEnabled: false,
    clEnabled: false,
    ocrEnabled: false,
    whisperEnabled: false,
    qwenEnabled: false,
    semanticPoliticalEnabled: false,
    semanticModelId: 'qwen',
    generalThreshold: 0.35,
    characterThreshold: 0.45,
    unsafeThreshold: 0.7,
    sketchyThreshold: 0.65,
    maxTags: 40,
    videoMaxFrames: 4,
    applySafety: true,
    semanticPrompt: defaultSemanticPrompt,
    semanticPromptEnabled: true,
    semanticSearchEnabled: false,
  }
}

function selectedMediaSummary(posts) {
  return posts.reduce((acc, post) => {
    if (['.mp4', '.webm'].includes(post.extension)) acc.videos += 1
    else if (post.extension === '.gif') acc.gifs += 1
    else acc.images += 1
    return acc
  }, { images: 0, videos: 0, gifs: 0 })
}

export function useBatchAiTagging({ selection, operations }) {
  const { selectedIds, selectedItems } = selection
  const { busy, showMessage, beginBatchOperation, failBatchOperation, trackAutoJob } = operations

  const savedAutoTagSettings = ref({})
  const savedAutoTagProfileDefaults = ref({ custom: {}, anime: {}, realistic: {} })
  const batchAiProfile = ref('default')
  const batchAiSettings = ref(defaultBatchAiSettings())

  const batchAiProfiles = computed(() => [
    {
      id: 'default',
      label: 'Default',
      short: 'Saved settings',
      help: 'Uses the model checkboxes, thresholds, safety behavior, and prompt saved in Settings.',
    },
    {
      id: 'anime',
      label: 'Anime',
      short: profileStackSummary('anime'),
      help: 'Uses the Anime / Booru model stack saved in Settings.',
    },
    {
      id: 'realistic',
      label: 'Realistic',
      short: profileStackSummary('realistic'),
      help: 'Uses the Realistic model stack saved in Settings.',
    },
    {
      id: 'custom',
      label: 'Custom',
      short: profileStackSummary('custom'),
      help: 'Starts from the Custom model stack saved in Settings, then uses any edits shown in this batch panel.',
    },
  ])

  function profileStack(profileId) {
    if (profileId === 'custom') return normalizeAiModelDefaults(batchAiSettings.value)
    return normalizeAiModelDefaults(savedAutoTagProfileDefaults.value?.[profileId] || {})
  }

  function profileStackSummary(profileId) {
    const stack = profileStack(profileId)
    const names = modelFlags({ models: true }).filter((flag) => stack[flag.key]).map((flag) => flag.label)
    return names.length ? names.join(' + ') : 'No models enabled'
  }

  function batchAiRunSettings() {
    const base = {
      ...(savedAutoTagSettings.value || {}),
      enabled: true,
    }
    if (batchAiProfile.value === 'default') return base
    const counts = selectedMediaSummary(selectedItems.value)
    const hasVideo = counts.videos > 0
    if (batchAiProfile.value === 'custom') {
      const stack = normalizeAiModelDefaults(batchAiSettings.value)
      return {
        ...base,
        ...batchAiSettings.value,
        ...stack,
        semanticPoliticalEnabled: stack.qwenEnabled === true,
        whisperEnabled: hasVideo && stack.whisperEnabled === true,
        enabled: true,
      }
    }

    const profileSettings = profileRunSettings(batchAiProfile.value, {
      isVideo: hasVideo,
      profileStack: savedAutoTagProfileDefaults.value?.[batchAiProfile.value] || {},
      savedSettings: base,
    })
    return profileSettings ? { ...base, ...profileSettings, enabled: true } : base
  }

  async function loadBatchAiSettings() {
    try {
      const [settings, defaultsResult] = await Promise.all([
        api.getAutoTagSettings(),
        api.getAiModelDefaults(),
        loadAiModelRegistry(),
      ])
      const modelDefaults = normalizeAiModelDefaults(defaultsResult?.modelDefaults)
      savedAutoTagProfileDefaults.value = normalizeAiProfileDefaults(defaultsResult?.modelDefaults?.profileDefaults, modelDefaults)
      const customDefaults = savedAutoTagProfileDefaults.value.custom || modelDefaults
      savedAutoTagSettings.value = { ...settings }
      batchAiSettings.value = {
        ...defaultBatchAiSettings(),
        ...settings,
        ...customDefaults,
        enabled: true,
        semanticPoliticalEnabled: customDefaults.qwenEnabled === true,
        semanticPrompt: settings.semanticPrompt || defaultSemanticPrompt,
        semanticModelId: settings.semanticModelId || 'qwen',
      }
    } catch (e) {
      console.error('Failed to load batch AI settings:', e)
    }
  }

  async function runBatchAutoTag(dryRun) {
    if (!selectedIds.value.length || busy.value) return
    busy.value = true
    try {
      beginBatchOperation(
        dryRun ? 'Starting AI preview job' : 'Starting AI run & apply job',
        'Sending selected post IDs and model settings to the backend.',
        selectedIds.value.length,
      )
      const job = await api.createAutoTagJob({
        mode: 'selected',
        dryRun,
        postIds: [...selectedIds.value],
        settings: batchAiRunSettings(),
      })
      trackAutoJob(job)
      showMessage(
        dryRun
          ? `AI preview job started for ${job.total ?? selectedIds.value.length} selected post(s). Review it in Settings.`
          : `AI run & apply job started for ${job.total ?? selectedIds.value.length} selected post(s).`,
      )
    } catch (e) {
      failBatchOperation(e.message)
      showMessage(`AI batch job failed: ${e.message}`, 'error')
    } finally {
      busy.value = false
    }
  }

  return {
    batchAiProfile,
    batchAiProfiles,
    batchAiSettings,
    batchModelOptions: computed(batchModelOptions),
    loadBatchAiSettings,
    runBatchAutoTag,
  }
}
