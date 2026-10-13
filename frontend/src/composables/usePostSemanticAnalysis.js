import { ref, computed, watch } from 'vue'
import { api } from '../api/client'
import { formatDurationMs } from '../utils/format'

// Loads (and caches per post) the stored Qwen semantic description for the
// post shown in the batch panel's "Hovered Post Details" card.

function parseSemanticRawOutput(raw) {
  const text = String(raw || '').trim()
  if (!text) return {}
  try {
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    const rationale = extractJsonStringFragment(text, 'rationale')
    const description = extractJsonStringFragment(text, 'description')
    const summary = extractJsonStringFragment(text, 'summary')
    return { rationale, description, summary }
  }
}

function extractJsonStringFragment(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quoted = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i').exec(text)
  const fragment = quoted?.[1] || new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*)$`, 'i').exec(text)?.[1] || ''
  return fragment
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/[}\],\s]*$/g, '')
    .trim()
}

function cleanSemanticDescription(value) {
  const text = String(value || '').trim()
  if (/^[{\[]/.test(text)) return ''
  return text
    .replace(/\s+/g, ' ')
    .replace(/^rationale:\s*/i, '')
    .trim()
}

function semanticDescriptionFromField(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (!/^[{\[]/.test(text)) return text
  const parsed = parseSemanticRawOutput(text)
  return (
    parsed.rationale ||
    parsed.description ||
    parsed.summary ||
    parsed.scene ||
    ''
  )
}

function aiAnalysisDescription(analysis) {
  if (analysis?.description) return String(analysis.description).trim()
  return cleanSemanticDescription(
    semanticDescriptionFromField(analysis?.rationale) ||
    semanticDescriptionFromField(analysis?.summary) ||
    semanticDescriptionFromField(analysis?.rawOutput)
  )
}

function semanticResultFromAnalysis(analysis) {
  const description = aiAnalysisDescription(analysis)
  if (!description) return null
  const rawParsed = parseSemanticRawOutput(analysis.rawOutput)
  const semanticTags = Array.isArray(analysis.semanticTags) && analysis.semanticTags.length
    ? analysis.semanticTags
    : (Array.isArray(rawParsed.tags) ? rawParsed.tags : [])
  return {
    model: analysis.modelName || analysis.modelId || 'Qwen',
    timing: formatDurationMs(analysis.durationMs),
    description,
    tags: semanticTags.map(String).filter(Boolean).slice(0, 12),
  }
}

export function usePostSemanticAnalysis(inspectedPost) {
  const cache = ref({})
  const loading = ref(false)
  let requestCounter = 0

  const analysis = computed(() => {
    const id = inspectedPost.value?.id
    if (id == null) return null
    return cache.value[id] || null
  })

  async function load(postId) {
    if (!postId || Object.prototype.hasOwnProperty.call(cache.value, postId)) return
    const requestId = ++requestCounter
    loading.value = true
    try {
      const result = await api.getPostAiAnalysis(postId)
      const found = (result.results || [])
        .map(semanticResultFromAnalysis)
        .find(Boolean) || null
      cache.value = {
        ...cache.value,
        [postId]: found,
      }
    } catch {
      cache.value = {
        ...cache.value,
        [postId]: null,
      }
    } finally {
      if (requestId === requestCounter) loading.value = false
    }
  }

  watch(
    () => inspectedPost.value?.id,
    (postId) => {
      if (!postId) {
        loading.value = false
        return
      }
      if (Object.prototype.hasOwnProperty.call(cache.value, postId)) {
        loading.value = false
        return
      }
      load(postId)
    },
    { immediate: true }
  )

  return {
    inspectedSemanticAnalysis: analysis,
    inspectedSemanticLoading: loading,
  }
}
