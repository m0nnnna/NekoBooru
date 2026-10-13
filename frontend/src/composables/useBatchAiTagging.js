import { ref, computed } from 'vue'
import { api } from '../api/client'

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

// Keep in sync with the other views' model-key lists (see CLAUDE.md).
const aiModelDefaultKeys = ['wdEnabled', 'pixaiEnabled', 'characterModelEnabled', 'clEnabled', 'qwenEnabled', 'semanticPoliticalEnabled', 'ocrEnabled', 'whisperEnabled']

export const batchModelOptions = [
  { key: 'wdEnabled', label: 'WD Tagger', help: 'Broad booru/media tags from images and sampled video frames.' },
  { key: 'pixaiEnabled', label: 'PixAI Tagger v0.9', help: 'Fast PixAI/Danbooru anime and illustration tags.' },
  { key: 'characterModelEnabled', label: 'Camie Tagger v2', help: 'Anime character, copyright, artist, and rating tags.' },
  { key: 'clEnabled', label: 'CL Tagger v2', help: 'SigLIP2 Danbooru tagger with a 108k-tag character/copyright/general vocabulary.' },
  { key: 'ocrEnabled', label: 'TrOCR Printed', help: 'Visible text, captions, subtitle, and meme text extraction.' },
  { key: 'whisperEnabled', label: 'Whisper Small', help: 'Speech, music, AMV/edit, and audio transcript signals for videos.' },
  { key: 'qwenEnabled', label: 'Qwen Semantic', help: 'Higher-level scene, political/edit, propaganda, and contextual tags.' },
]

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

function normalizeAiModelDefaults(raw = {}) {
  const defaults = raw && typeof raw === 'object' ? raw : {}
  const normalized = {}
  for (const key of aiModelDefaultKeys) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      normalized[key] = defaults[key] === true
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'qwenEnabled') && !Object.prototype.hasOwnProperty.call(normalized, 'semanticPoliticalEnabled')) {
    normalized.semanticPoliticalEnabled = normalized.qwenEnabled
  }
  return normalized
}

function normalizeAiProfileDefaults(raw = {}, fallback = {}) {
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
    const names = [
      stack.wdEnabled ? 'WD' : '',
      stack.pixaiEnabled ? 'PixAI' : '',
      stack.characterModelEnabled ? 'Camie' : '',
      stack.clEnabled ? 'CL' : '',
      stack.qwenEnabled ? 'Qwen' : '',
      stack.ocrEnabled ? 'OCR' : '',
      stack.whisperEnabled ? 'audio' : '',
    ].filter(Boolean)
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

    const stack = profileStack(batchAiProfile.value)
    if (batchAiProfile.value === 'anime') {
      return {
        ...base,
        enabled: true,
        ...stack,
        semanticPoliticalEnabled: stack.qwenEnabled === true,
        whisperEnabled: hasVideo && stack.whisperEnabled === true,
        generalThreshold: 0.35,
        characterThreshold: 0.45,
        maxTags: 40,
        videoMaxFrames: 4,
      }
    }
    if (batchAiProfile.value === 'realistic') {
      return {
        ...base,
        enabled: true,
        ...stack,
        semanticPoliticalEnabled: stack.qwenEnabled === true,
        whisperEnabled: hasVideo && stack.whisperEnabled === true,
        generalThreshold: 0.5,
        characterThreshold: 0.6,
        maxTags: hasVideo ? 20 : 18,
        videoMaxFrames: 4,
      }
    }
    return base
  }

  async function loadBatchAiSettings() {
    try {
      const [settings, defaultsResult] = await Promise.all([
        api.getAutoTagSettings(),
        api.getAiModelDefaults(),
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
    batchModelOptions,
    loadBatchAiSettings,
    runBatchAutoTag,
  }
}
