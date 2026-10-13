// Upload popup: rendering an AI tag suggestion - the tag preview, the
// semantic summary and the per-model evidence list.
//
// Plain script sharing upload.html's global scope; loaded before upload.js.

function renderAiPreview(suggestion) {
  const timing = formatDurationMs(suggestion.durationMs ?? suggestion.evidence?.durationMs)
  els.aiPreviewTiming.textContent = timing ? `Completed in ${timing}` : ''
  els.aiPreviewSafety.textContent = suggestion.suggestedSafety || 'unchanged'
  renderAiPreviewTags(suggestion)

  renderSemanticPreview(suggestion)

  els.aiEvidenceList.innerHTML = ''
  aiEvidenceModels(suggestion).forEach((model) => {
    const row = document.createElement('div')
    row.className = 'ai-evidence-row'
    const title = document.createElement('strong')
    title.textContent = model.model || 'Auto tagger'
    row.appendChild(title)

    const dl = document.createElement('dl')
    evidenceRows(model).forEach((item) => {
      const dt = document.createElement('dt')
      dt.textContent = item.label
      const dd = document.createElement('dd')
      dd.textContent = item.value
      dl.append(dt, dd)
    })
    row.appendChild(dl)
    els.aiEvidenceList.appendChild(row)
  })

  els.aiPreview.classList.remove('hidden')
}

// Danbooru sidebar order and colours, kept in step with the tag_categories
// defaults the backend seeds and with frontend/src/components/TagSidebar.vue.
const AI_TAG_CATEGORIES = [
  { category: 'artist', label: 'Artist', color: '#f8a100' },
  { category: 'character', label: 'Character', color: '#00c853' },
  { category: 'copyright', label: 'Copyright', color: '#d500f9' },
  { category: 'meta', label: 'Metadata', color: '#ff5252' },
  { category: 'general', label: 'Tag', color: '#0075f8' },
]

function renderAiPreviewTags(suggestion) {
  els.aiPreviewTags.innerHTML = ''
  const tags = suggestion.suggestedTags || []
  if (!tags.length) return

  // The preview response already carries a tag -> category map; it used to be
  // dropped and every tag rendered as an identical pill.
  const categories = suggestion.categories || {}
  const grouped = new Map()
  tags.forEach((tag) => {
    const category = categories[tag] || 'general'
    if (!grouped.has(category)) grouped.set(category, [])
    grouped.get(category).push(tag)
  })

  const known = AI_TAG_CATEGORIES.map((entry) => entry.category)
  const extra = [...grouped.keys()]
    .filter((category) => !known.includes(category))
    .sort()
    .map((category) => ({ category, label: category.replace(/[_-]+/g, ' '), color: '#0075f8' }))

  ;[...AI_TAG_CATEGORIES, ...extra].forEach((entry) => {
    const entryTags = grouped.get(entry.category)
    if (!entryTags?.length) return

    const group = document.createElement('div')
    group.className = 'ai-tag-group'

    const heading = document.createElement('h5')
    heading.className = 'ai-tag-heading'
    heading.style.color = entry.color
    heading.textContent = entry.label
    group.appendChild(heading)

    const list = document.createElement('ul')
    list.className = 'ai-tag-rows'
    entryTags.slice(0, 60).sort((a, b) => a.localeCompare(b)).forEach((tag) => {
      const row = document.createElement('li')
      row.className = 'ai-tag-row'
      const name = document.createElement('span')
      name.className = 'ai-tag-name'
      name.style.color = entry.color
      name.textContent = String(tag).replace(/_/g, ' ')
      name.title = tag
      row.appendChild(name)
      list.appendChild(row)
    })
    group.appendChild(list)
    els.aiPreviewTags.appendChild(group)
  })
}

function renderSemanticPreview(suggestion) {
  const semantic = semanticPreviewFromSuggestion(suggestion)
  els.aiPreviewSemantic.innerHTML = ''
  els.aiPreviewSemantic.classList.toggle('hidden', !semantic)
  if (!semantic) return

  const head = document.createElement('div')
  head.className = 'semantic-preview-head'
  const title = document.createElement('strong')
  title.textContent = 'Semantic Analysis'
  const meta = document.createElement('small')
  meta.textContent = [semantic.model, semantic.timing].filter(Boolean).join(' · ')
  head.append(title, meta)

  const body = document.createElement('p')
  body.textContent = semantic.rationale || semantic.summary || semantic.raw || ''

  els.aiPreviewSemantic.append(head, body)
  if (semantic.tags.length) {
    const tags = document.createElement('div')
    tags.className = 'semantic-preview-tags'
    semantic.tags.slice(0, 18).forEach((tag) => {
      const pill = document.createElement('span')
      pill.textContent = tag
      tags.appendChild(pill)
    })
    els.aiPreviewSemantic.appendChild(tags)
  }
}

function semanticPreviewFromSuggestion(suggestion) {
  const models = aiEvidenceModels(suggestion)
  for (const model of models) {
    const evidence = model.evidence || {}
    const parsed = semanticParsedEvidence(evidence)
    const marker = `${model.model || ''} ${evidence.kind || ''} ${evidence.modelId || ''}`.toLowerCase()
    const isSemantic = marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
    if (!isSemantic) continue
    const rationale = String(parsed.rationale || parsed.description || parsed.summary || '').trim()
    const raw = String(evidence.raw || '').trim()
    const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : []
    if (!rationale && !raw && !tags.length) continue
    const timing = formatDurationMs(model.durationMs ?? evidence.durationMs)
    return {
      model: model.model || evidence.modelId || 'Qwen',
      timing,
      rationale,
      summary: String(parsed.summary || parsed.description || '').trim(),
      raw,
      tags,
    }
  }
  return null
}

function aiEvidenceModels(suggestion) {
  const evidence = suggestion?.evidence
  if (!evidence) return []
  if (Array.isArray(evidence.models)) return evidence.models
  return [{ model: suggestion.model || 'Auto tagger', evidence }]
}

function evidenceRows(model) {
  const evidence = model.evidence || {}
  const parsed = semanticParsedEvidence(evidence)
  const rows = []
  const duration = Number(model.durationMs ?? evidence.durationMs)
  if (Number.isFinite(duration) && duration > 0) {
    rows.push({ label: 'Time', value: formatDurationMs(duration) })
  }
  if (model.error) rows.push({ label: 'Error', value: model.error })
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
    rows.push({ label: 'Rating', value: formatScoreMap(evidence.rating) })
  }
  if (evidence.text) rows.push({ label: 'OCR text', value: String(evidence.text).slice(0, 500) })
  if (evidence.transcript) rows.push({ label: 'Transcript', value: String(evidence.transcript).slice(0, 500) })
  if (parsed.tags?.length) rows.push({ label: 'Semantic', value: parsed.tags.join(', ') })
  if (parsed.safety) rows.push({ label: 'Safety', value: parsed.safety })
  if (parsed.rationale) {
    rows.push({ label: 'Semantic analysis', value: String(parsed.rationale).slice(0, 800) })
  }
  if (evidence.raw && !rows.some((row) => row.label === 'Semantic')) {
    rows.push({ label: 'Output', value: String(evidence.raw).slice(0, 500) })
  }
  if (!rows.length) rows.push({ label: 'Details', value: 'No structured evidence returned.' })
  return rows
}

function formatVideoFrameSampling(videoFrames) {
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

function semanticParsedEvidence(evidence) {
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

function formatTagScore(item) {
  const tag = item.tag || item.name || String(item)
  const confidence = Number(item.confidence ?? item.score)
  if (!Number.isFinite(confidence)) return tag
  return `${tag} ${Math.round(confidence * 100)}%`
}

function formatScoreMap(map) {
  return Object.entries(map)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6)
    .map(([key, value]) => `${key} ${Math.round(Number(value) * 100)}%`)
    .join(', ')
}

function formatDurationMs(ms) {
  const value = Number(ms || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}
