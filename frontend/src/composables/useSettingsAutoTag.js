// Auto Tagging settings: the saved pipeline options and semantic prompt,
// pipeline / compute status, and the Hugging Face, Gelbooru and remote
// worker credentials. Also holds the model catalog the other AI pieces read.
import { computed, ref } from 'vue'
import api from '../api/client'

export function useSettingsAutoTag() {
  const autoTagSettings = ref({})
  const autoTagStatus = ref({})
  const savingAutoTags = ref(false)
  const semanticPromptStatus = ref({
    show: false,
    success: true,
    message: '',
  })
  const defaultSemanticPrompt = [
    'Return compact JSON with keys: tags, safety, rationale, safety_reason, confidence.',
    'Use snake_case tags only.',
    '',
    'Semantic description:',
    '- The rationale should be a direct factual caption of the visible content. Describe clothing garments, pose, setting, text, and audio/transcript evidence. When describing adult or NSFW visual content, respond plainly with a clear safety classification. If the content is erotic or sexually suggestive, say so plainly and explain why. Do not euphemize visible adult content, but do not invent details that are not visible. If lewd, sketchy, unsafe, or nsfw, explain the concrete visual reason: visible or emphasized body parts, nudity or partial nudity, transparent/tight/revealing garments, lingerie, swimwear, cleavage, underboob, sideboob, pose, framing, explicit acts, and why the safety rating was selected. Do not rely only on suggestive pose. Do not mention sampled frame counts, frame labels, contact sheets, timestamps, or model sampling mechanics.',
    '',
    'Example expected rationale style:',
    '"A single woman with long black hair and brown eyes is shown in a video. She wears a white lace bra and matching panties, revealing her breasts and cleavage. She smiles at the camera while sitting indoors, sometimes touching her head or hair, occasionally resting her hand on her chest or stomach. The setting appears to be an indoor room with soft lighting. Visible details include a mole under her mouth, bare shoulders, and her navel. The content is explicitly erotic due to the revealing lingerie, prominent cleavage, and suggestive poses."',
    '',
    'Safety values:',
    '- Use safety safe for ordinary SFW content, sketchy for suggestive/revealing content, and unsafe for explicit NSFW/adult erotic content. safety_reason should briefly explain the classification based only on visible evidence. confidence must be low, medium, or high.',
    '',
    'Tags in priority order:',
    '- Return 6-28 useful searchable tags supported by the image, frame, OCR, transcript, or source page.',
    '- For video frame collections or contact sheets, compare the sampled frames in order and infer temporal context, but describe it as the video/content, and do not output metadata tags or mention metadata such as frame_1, frame_2, three_frames, timestamps, contact_sheet, or sampled_frame.',
    '- When model tag hints are provided, use only their visual tags as grounding. Prefer specific animal type, ear, horn, tail, and clothing hints unless the image clearly contradicts them. Do not output named character, franchise, copyright, or source tags, and do not mention guessed identities in the rationale.',
    '- Start with directly visible tags: media type, exact pose/action, subject count, male/female/girl/boy, setting, objects, actions, expression, hair color, eye color, framing, text/audio presence, and meme/edit format.',
    '- Always include the main visible pose or action as a searchable tag when clear, such as lying, sitting, standing, kneeling, crouching, squatting, walking, running, jumping, dancing, sleeping, stretching, arms_up, looking_at_viewer, or selfie.',
    '- Decompose clothing into specific garments and attributes. Name the garment type separately from pattern or theme. Example cow_print_outfit, bikini, swimsuit, would all be included.',
    '- Do not confuse animal ears types or horns for clothing, or horns for ears. Tag what is visibly present, such as animal_ears, cow_horns, white_horns, tail, or cow_tail.',
    '- Add frequent or matching primary colors for the scene or clothing, hair color, eye color, standout accessories, exact pose, and anything visually distinctive.',
    '- Include screenshot, photo, video, image, or gif when they fit.',
    '- If lewd or nsfw explain what is erotic about it with concrete visible evidence, not only pose.',
    '- Add semantic/context tags only when supported: political_edit, meme_edit, amv, music_video, captioned, protest, politician, propaganda, music, edit, has_text, text_overlay, has_speech, swastika, sonnenrad, black_sun, national_socialism, hammer_and_sickle, communism.',
  ].join('\n')
  const huggingFaceToken = ref('')
  const savingToken = ref(false)
  const gelbooruUserId = ref('')
  const gelbooruApiKey = ref('')
  const savingGelbooruCredentials = ref(false)
  const gelbooruCredentialsMessage = ref({ show: false, success: false, message: '' })
  const modelCatalog = ref([])
  const modelDownloadJob = ref(null)
  const workerToken = ref('')
  const savingWorkerToken = ref(false)
  const testingWorker = ref(false)
  const modelStatusMessage = ref({
    show: false,
    success: false,
    message: '',
  })
  const thresholdHelp = {
    general: 'Minimum confidence for general booru tags. Lower values add more tags but more noise; raise it if posts are getting vague or wrong tags. Typical range: 0.30-0.45.',
    character: 'Minimum confidence for character, copyright, and source tags. Lower it if known characters are missed; raise it if false character names appear. Typical range: 0.40-0.60.',
    unsafe: 'Explicit-rating confidence required before auto-tagging can promote a post to unsafe. Questionable/sensitive evidence can only promote to sketchy when it is very strong. Raise this to avoid false unsafe ratings.',
    sketchy: 'Confidence required before auto-tagging can promote a post to sketchy. The backend enforces a conservative floor so weak questionable/sensitive evidence does not relabel ordinary posts.',
    maxTags: 'Maximum number of tags kept from model output. Increase for richer search coverage; decrease if posts become cluttered. This limit applies before manual review.',
    videoFrames: 'Number of sampled video frames for WD, Camie, CL, PixAI, and OCR frame-tag merging. 2 frames sample about 33% and 66%; 3 samples 25/50/75%; 4 samples 20/40/60/80%.',
    qwenVideoFrames: 'Maximum frames Qwen can inspect when 2 FPS video sampling is enabled. Off means Qwen sees one middle frame. On means Qwen samples every 0.5 seconds until this cap, then reasons over one contact sheet.',
    lightCutoff: 'Posts with this many tags or fewer count as lightly tagged for bulk jobs. Increase to retag sparse libraries; decrease to only target nearly empty posts.',
    inheritSimilar: 'When enabled, the auto-tagger copies tags from posts already in your library that are near-identical to the image being tagged (same image re-compressed, cropped, or resized). Works best for duplicate/variant detection — it does not match different-pose drawings of the same character.',
    similarDistance: 'Maximum perceptual-hash Hamming distance (0–64) for a library post to count as a match. 0 = pixel-perfect duplicates only; 8 = near-duplicates including mild re-encodes and crops. Raise it if variants are missed; lower it to avoid false matches.',
    similarMinTags: 'A matching library post must have at least this many tags to contribute to inheritance. Keeps untagged or barely-tagged posts out of the inheritance pool.',
  }
  const torchDeviceHelp = 'Auto uses CUDA/GPU when the installed torch build can see it, otherwise CPU. GPU only forces CUDA and reports an error if this venv has CPU-only torch. CPU only is slower but useful when you need VRAM free.'

  const aiRuntimeMissing = computed(() => {
    // When offloading to a remote worker, the runtime lives on the worker, not here.
    if (autoTagSettings.value.remoteEnabled) return false
    const deps = autoTagStatus.value.dependencies || {}
    // Nothing can run without at least an inference runtime. ONNX powers the
    // baseline WD/Camie taggers; torch powers OCR/Whisper/Qwen.
    return !deps.onnxruntime && !deps.torch
  })

  const remoteWorkerSummary = computed(() => {
    const remote = autoTagStatus.value.remote || {}
    if (!autoTagSettings.value.remoteEnabled) return 'Local inference'
    if (!remote.url) return 'Enter the worker URL'
    if (remote.reachable) {
      const torch = remote.worker?.torch || {}
      const where = torch.cudaAvailable
        ? `GPU: ${torch.devices?.[0]?.name || 'CUDA'}`
        : (torch.available ? 'worker on CPU' : 'worker has no torch')
      return `Connected · ${where}`
    }
    return remote.error ? `Unreachable (${remote.error})` : 'Not connected — Test connection'
  })

  const effectiveTorch = computed(() => {
    const remote = autoTagStatus.value.remote || {}
    if (autoTagSettings.value.remoteEnabled && remote.reachable && remote.worker?.torch) {
      return remote.worker.torch
    }
    return autoTagStatus.value.torch || {}
  })

  const effectiveOnnxReady = computed(() => {
    const remote = autoTagStatus.value.remote || {}
    if (autoTagSettings.value.remoteEnabled && remote.reachable && remote.worker?.onnx) {
      return !!remote.worker.onnx.availableProviders?.length || !!remote.worker.onnx.available
    }
    return !!autoTagStatus.value.dependencies?.onnxruntime
  })

  const torchSummary = computed(() => {
    const torch = effectiveTorch.value
    if (!torch.available) return 'Torch missing'
    if (!torch.cudaAvailable) return 'CPU only'
    const first = torch.devices?.[0]
    return first ? `GPU: ${first.name}` : 'CUDA ready'
  })

  const torchDeviceDetail = computed(() => {
    const torch = effectiveTorch.value
    const qwen = autoTagStatus.value.qwenDevice || {}
    if (!torch.available) return 'Install torch before using Qwen, OCR, or Whisper.'
    if (!torch.cudaAvailable) return 'CUDA is not available to the active AI runtime. Qwen will load on CPU unless you install a CUDA torch wheel or connect a GPU worker.'
    const devices = (torch.devices || [])
      .map((device) => `${device.name} ${device.totalMemoryGb} GB VRAM`)
      .join(', ')
    const loaded = qwen.loaded ? `Qwen loaded via ${qwen.device || 'device map'}.` : 'Qwen is not loaded.'
    return `${devices || 'CUDA device detected'}. ${loaded}`
  })

  async function saveAutoTagSettings() {
    savingAutoTags.value = true
    try {
      autoTagSettings.value.semanticPrompt = (autoTagSettings.value.semanticPrompt || defaultSemanticPrompt).trim()
      autoTagSettings.value.semanticPromptEnabled = autoTagSettings.value.semanticPromptEnabled !== false
      autoTagSettings.value.semanticSearchEnabled = autoTagSettings.value.semanticSearchEnabled === true
      autoTagSettings.value.saveSemanticAnalysis = autoTagSettings.value.saveSemanticAnalysis === true
      autoTagSettings.value.semanticModelId = autoTagSettings.value.semanticModelId || 'qwen'
      autoTagSettings.value = await api.updateAutoTagSettings(autoTagSettings.value)
      autoTagStatus.value = await api.getAutoTagStatus()
    } catch (e) {
      alert('Failed to save auto tag settings: ' + e.message)
    } finally {
      savingAutoTags.value = false
    }
  }

  function resetSemanticPrompt() {
    autoTagSettings.value.semanticPrompt = defaultSemanticPrompt
    semanticPromptStatus.value = {
      show: true,
      success: true,
      message: 'Default prompt restored. Click Save Prompt to persist it.',
    }
  }

  async function saveSemanticPrompt() {
    savingAutoTags.value = true
    semanticPromptStatus.value.show = false
    try {
      autoTagSettings.value.semanticPrompt = (autoTagSettings.value.semanticPrompt || defaultSemanticPrompt).trim()
      autoTagSettings.value.semanticPromptEnabled = autoTagSettings.value.semanticPromptEnabled !== false
      autoTagSettings.value.semanticSearchEnabled = autoTagSettings.value.semanticSearchEnabled === true
      autoTagSettings.value.saveSemanticAnalysis = autoTagSettings.value.saveSemanticAnalysis === true
      autoTagSettings.value.semanticModelId = autoTagSettings.value.semanticModelId || 'qwen'
      autoTagSettings.value = await api.updateAutoTagSettings(autoTagSettings.value)
      autoTagStatus.value = await api.getAutoTagStatus()
      semanticPromptStatus.value = {
        show: true,
        success: true,
        message: 'Semantic prompt saved.',
      }
    } catch (e) {
      semanticPromptStatus.value = {
        show: true,
        success: false,
        message: 'Failed to save semantic prompt: ' + e.message,
      }
    } finally {
      savingAutoTags.value = false
    }
  }

  async function refreshAutoTagStatus() {
    try {
      const [statusResult, modelsResult] = await Promise.all([
        api.getAutoTagStatus(),
        api.getAutoTagModels(),
      ])
      autoTagStatus.value = statusResult
      modelCatalog.value = modelsResult.models || []
      modelDownloadJob.value = modelsResult.downloadJob
    } catch (e) {
      alert('Failed to refresh auto tag status: ' + e.message)
    }
  }

  async function saveHuggingFaceToken() {
    if (!huggingFaceToken.value.trim()) return
    savingToken.value = true
    modelStatusMessage.value.show = false
    try {
      autoTagStatus.value = await api.saveHuggingFaceToken(huggingFaceToken.value.trim())
      huggingFaceToken.value = ''
      modelStatusMessage.value = {
        show: true,
        success: true,
        message: 'Hugging Face token saved.',
      }
    } catch (e) {
      modelStatusMessage.value = {
        show: true,
        success: false,
        message: 'Failed to save Hugging Face token: ' + e.message,
      }
    } finally {
      savingToken.value = false
    }
  }

  async function deleteHuggingFaceToken() {
    savingToken.value = true
    modelStatusMessage.value.show = false
    try {
      autoTagStatus.value = await api.deleteHuggingFaceToken()
      modelStatusMessage.value = {
        show: true,
        success: true,
        message: 'Hugging Face token removed.',
      }
    } catch (e) {
      modelStatusMessage.value = {
        show: true,
        success: false,
        message: 'Failed to remove Hugging Face token: ' + e.message,
      }
    } finally {
      savingToken.value = false
    }
  }

  async function saveGelbooruCredentials() {
    const userId = gelbooruUserId.value.trim()
    const apiKey = gelbooruApiKey.value.trim()
    if (!userId || !apiKey) return
    savingGelbooruCredentials.value = true
    gelbooruCredentialsMessage.value.show = false
    try {
      autoTagStatus.value = await api.saveGelbooruCredentials(userId, apiKey)
      gelbooruUserId.value = ''
      gelbooruApiKey.value = ''
      gelbooruCredentialsMessage.value = {
        show: true,
        success: true,
        message: 'Gelbooru API credentials saved.',
      }
    } catch (e) {
      gelbooruCredentialsMessage.value = {
        show: true,
        success: false,
        message: 'Failed to save Gelbooru credentials: ' + e.message,
      }
    } finally {
      savingGelbooruCredentials.value = false
    }
  }

  async function deleteGelbooruCredentials() {
    savingGelbooruCredentials.value = true
    gelbooruCredentialsMessage.value.show = false
    try {
      autoTagStatus.value = await api.deleteGelbooruCredentials()
      gelbooruUserId.value = ''
      gelbooruApiKey.value = ''
      gelbooruCredentialsMessage.value = {
        show: true,
        success: true,
        message: 'Gelbooru API credentials removed.',
      }
    } catch (e) {
      gelbooruCredentialsMessage.value = {
        show: true,
        success: false,
        message: 'Failed to remove Gelbooru credentials: ' + e.message,
      }
    } finally {
      savingGelbooruCredentials.value = false
    }
  }

  async function saveWorkerToken() {
    if (!workerToken.value.trim()) return
    savingWorkerToken.value = true
    try {
      autoTagStatus.value = await api.saveTaggerWorkerToken(workerToken.value.trim())
      workerToken.value = ''
    } catch (e) {
      alert('Failed to save worker token: ' + e.message)
    } finally {
      savingWorkerToken.value = false
    }
  }

  async function deleteWorkerToken() {
    savingWorkerToken.value = true
    try {
      autoTagStatus.value = await api.deleteTaggerWorkerToken()
    } catch (e) {
      alert('Failed to remove worker token: ' + e.message)
    } finally {
      savingWorkerToken.value = false
    }
  }

  async function testWorker() {
    testingWorker.value = true
    try {
      // Persist URL/enabled first so the backend probes the right worker.
      await saveAutoTagSettings()
      await refreshAutoTagStatus()
    } finally {
      testingWorker.value = false
    }
  }
  return {
    autoTagSettings,
    autoTagStatus,
    savingAutoTags,
    semanticPromptStatus,
    defaultSemanticPrompt,
    huggingFaceToken,
    savingToken,
    gelbooruUserId,
    gelbooruApiKey,
    savingGelbooruCredentials,
    gelbooruCredentialsMessage,
    modelCatalog,
    modelDownloadJob,
    workerToken,
    savingWorkerToken,
    testingWorker,
    modelStatusMessage,
    thresholdHelp,
    torchDeviceHelp,
    aiRuntimeMissing,
    remoteWorkerSummary,
    effectiveTorch,
    effectiveOnnxReady,
    torchSummary,
    torchDeviceDetail,
    saveAutoTagSettings,
    resetSemanticPrompt,
    saveSemanticPrompt,
    refreshAutoTagStatus,
    saveHuggingFaceToken,
    deleteHuggingFaceToken,
    saveGelbooruCredentials,
    deleteGelbooruCredentials,
    saveWorkerToken,
    deleteWorkerToken,
    testWorker,
  }
}
