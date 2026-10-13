// Saved semantic analyses for the post (the sidebar description and its
// editor), plus the helpers that read model evidence and semantic output.
import { ref, computed } from 'vue'
import api from '../api/client'
import { formatDurationMs } from '../utils/format'

export function evidenceRows(model) {
  const evidence = model.evidence || {}
  const parsed = semanticParsedEvidence(evidence)
  const rows = []
  const duration = Number(model.durationMs ?? evidence.durationMs)
  if (Number.isFinite(duration) && duration > 0) {
    rows.push({ label: 'Time', value: formatDurationMs(duration) })
  }
  if (evidence.kind) rows.push({ label: 'Source', value: evidence.kind })
  if (evidence.videoFrames) rows.push({ label: 'Frame sampling', value: formatVideoFrameSampling(evidence.videoFrames) })
  if (Array.isArray(evidence.topTags) && evidence.topTags.length) {
    rows.push({ label: 'Top tags', value: evidence.topTags.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (Array.isArray(evidence.topCharacters) && evidence.topCharacters.length) {
    rows.push({ label: 'Characters', value: evidence.topCharacters.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (Array.isArray(evidence.topCopyrights) && evidence.topCopyrights.length) {
    rows.push({ label: 'Copyrights', value: evidence.topCopyrights.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (evidence.rating && Object.keys(evidence.rating).length) {
    rows.push({ label: 'Rating evidence', value: formatScoreMap(evidence.rating) })
  }
  if (evidence.text) rows.push({ label: 'OCR text', value: evidence.text })
  if (evidence.transcript) rows.push({ label: 'Transcript', value: evidence.transcript })
  if (parsed.tags?.length) rows.push({ label: 'Semantic tags', value: parsed.tags.join(', ') })
  if (parsed.safety) rows.push({ label: 'Semantic safety', value: parsed.safety })
  if (parsed.rationale) rows.push({ label: 'Semantic analysis', value: String(parsed.rationale).slice(0, 800) })
  if (evidence.raw && !rows.some((row) => row.label === 'Semantic tags')) {
    rows.push({ label: 'Model output', value: String(evidence.raw).slice(0, 500) })
  }
  if (!rows.length && model.error) rows.push({ label: 'Status', value: model.error })
  if (!rows.length) rows.push({ label: 'Details', value: 'No structured evidence returned.' })
  return rows
}

export function formatVideoFrameSampling(videoFrames) {
  if (!videoFrames || typeof videoFrames !== 'object') return ''
  const count = Number(videoFrames.count)
  const mode = String(videoFrames.mode || '')
  const label = mode === 'single'
    ? 'single middle frame'
    : mode === 'native_video_2fps'
      ? 'native video at 2 FPS'
    : mode === 'contact_sheet_2fps'
      ? '2 FPS contact sheet'
      : 'contact sheet'
  const timestamps = Array.isArray(videoFrames.timestamps)
    ? videoFrames.timestamps.slice(0, 12).map((ts) => `${Number(ts).toFixed(2)}s`).join(', ')
    : ''
  const suffix = timestamps ? ` (${timestamps}${videoFrames.timestamps.length > 12 ? ', ...' : ''})` : ''
  return `${label}${Number.isFinite(count) ? `, ${count} sampled` : ''}${suffix}`
}

export function semanticParsedEvidence(evidence) {
  if (evidence?.parsed && typeof evidence.parsed === 'object') return evidence.parsed
  const raw = String(evidence?.raw || '').trim()
  if (!raw) return {}
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function parseSemanticRawOutput(raw) {
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

export function extractJsonStringFragment(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quoted = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i').exec(text)
  const fragment = quoted?.[1] || new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*)$`, 'i').exec(text)?.[1] || ''
  return fragment
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/[}\],\s]*$/g, '')
    .trim()
}

export function cleanSemanticDescription(value) {
  const text = String(value || '').trim()
  if (/^[{\[]/.test(text)) return ''
  return text
    .replace(/\s+/g, ' ')
    .replace(/^rationale:\s*/i, '')
    .trim()
}

export function formatTagScore(item) {
  const tag = item.tag || item.name || String(item)
  const confidence = Number(item.confidence ?? item.score)
  if (!Number.isFinite(confidence)) return tag
  return `${tag} ${Math.round(confidence * 100)}%`
}

export function formatScoreMap(map) {
  return Object.entries(map)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6)
    .map(([key, value]) => `${key} ${Math.round(Number(value) * 100)}%`)
    .join(', ')
}

export function aiAnalysisDescription(analysis) {
  if (analysis?.description) return String(analysis.description).trim()
  return cleanSemanticDescription(
    semanticDescriptionFromField(analysis?.rationale) ||
    semanticDescriptionFromField(analysis?.summary) ||
    semanticDescriptionFromField(analysis?.rawOutput)
  )
}

export function semanticDescriptionFromField(value) {
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

export function usePostPageAiAnalysis({ post }) {
  const postAiAnalyses = ref([])
  const editingAiAnalysisId = ref(null)
  const aiAnalysisDescriptionDraft = ref('')
  const savingAiAnalysis = ref(false)
  const aiAnalysisEditError = ref('')

  const semanticSidebarAnalysis = computed(() => {
    for (const analysis of postAiAnalyses.value || []) {
      const description = aiAnalysisDescription(analysis)
      if (!description) continue
      const rawParsed = parseSemanticRawOutput(analysis.rawOutput)
      const semanticTags = Array.isArray(analysis.semanticTags) && analysis.semanticTags.length
        ? analysis.semanticTags
        : (Array.isArray(rawParsed.tags) ? rawParsed.tags : [])
      return {
        id: analysis.id,
        model: analysis.modelName || analysis.modelId || 'Qwen',
        profile: analysis.profile || 'default',
        timing: formatDurationMs(analysis.durationMs),
        description,
        tags: semanticTags.map(String).filter(Boolean).slice(0, 12),
      }
    }
    return null
  })

  async function loadPostAiAnalysis() {
    if (!post.value?.id) return
    try {
      const result = await api.getPostAiAnalysis(post.value.id)
      postAiAnalyses.value = result.results || []
    } catch {
      postAiAnalyses.value = []
    }
  }

  function startEditAiAnalysis(analysis) {
    editingAiAnalysisId.value = analysis.id
    aiAnalysisDescriptionDraft.value = aiAnalysisDescription(analysis)
    aiAnalysisEditError.value = ''
  }

  function cancelEditAiAnalysis() {
    editingAiAnalysisId.value = null
    aiAnalysisDescriptionDraft.value = ''
    aiAnalysisEditError.value = ''
  }

  async function saveAiAnalysisDescription(analysis) {
    if (!post.value?.id || !analysis?.id) return
    savingAiAnalysis.value = true
    aiAnalysisEditError.value = ''
    try {
      const updated = await api.updatePostAiAnalysis(post.value.id, analysis.id, {
        description: aiAnalysisDescriptionDraft.value,
      })
      postAiAnalyses.value = postAiAnalyses.value.map((item) => (
        item.id === updated.id ? updated : item
      ))
      cancelEditAiAnalysis()
    } catch (error) {
      aiAnalysisEditError.value = error.message || 'Failed to save description.'
    } finally {
      savingAiAnalysis.value = false
    }
  }
  return {
    postAiAnalyses,
    editingAiAnalysisId,
    aiAnalysisDescriptionDraft,
    savingAiAnalysis,
    aiAnalysisEditError,
    semanticSidebarAnalysis,
    loadPostAiAnalysis,
    startEditAiAnalysis,
    cancelEditAiAnalysis,
    saveAiAnalysisDescription,
  }
}
