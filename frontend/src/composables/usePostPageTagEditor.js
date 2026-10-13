// The post page's Edit Tags dialog: pill and raw-text modes, raw-text
// autocomplete, and saving.
import { ref } from 'vue'
import api from '../api/client'
import { useTagsStore } from '../stores/tags'

export function usePostPageTagEditor({ post, loadPost }) {
  const tagsStore = useTagsStore()
  const showTagEditor = ref(false)
  const editedTags = ref([])
  const tagEditorMode = ref('visual')
  const rawEditedTags = ref('')
  const rawTagTextarea = ref(null)
  const rawTagSuggestions = ref([])
  const rawTagSelectedIndex = ref(-1)
  const NAME_PART_AUTOCOMPLETE_KEY = 'nekobooru.namePartAutocompleteEnabled'
  let rawTagDebounceTimer = null

  function openTagEditor() {
    editedTags.value = [...(post.value?.tags || [])]
    tagEditorMode.value = 'visual'
    rawEditedTags.value = tagsToRawText(editedTags.value)
    showTagEditor.value = true
  }

  function setTagEditorMode(mode) {
    if (mode === tagEditorMode.value) return
    if (tagEditorMode.value === 'raw') {
      editedTags.value = parseRawTags(rawEditedTags.value)
      hideRawTagSuggestions()
    } else {
      rawEditedTags.value = tagsToRawText(editedTags.value)
    }
    tagEditorMode.value = mode
  }

  function clearEditedTags() {
    editedTags.value = []
    rawEditedTags.value = ''
    hideRawTagSuggestions()
  }

  function tagsToRawText(tags) {
    return (tags || []).join('\n')
  }

  function normalizeTagName(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '_')
  }

  function parseRawTags(raw) {
    const text = String(raw || '').trim()
    if (!text) return []

    let values = null
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) values = parsed
        else if (Array.isArray(parsed?.tags)) values = parsed.tags
      } catch {
        values = null
      }
    }

    if (!values) {
      values = text.split(/[\s,]+/)
    }

    const seen = new Set()
    const tags = []
    for (const value of values) {
      const tag = normalizeTagName(value)
      if (!tag || seen.has(tag)) continue
      seen.add(tag)
      tags.push(tag)
    }
    return tags
  }

  function rawTagTokenAtCursor() {
    const textarea = rawTagTextarea.value
    const value = rawEditedTags.value || ''
    const cursor = textarea?.selectionStart ?? value.length
    let start = cursor
    while (start > 0 && !/[\s,\[\]{}"']/.test(value[start - 1])) start -= 1
    let end = cursor
    while (end < value.length && !/[\s,\[\]{}"']/.test(value[end])) end += 1
    const rawToken = value.slice(start, end)
    const token = rawToken.startsWith('-') ? rawToken.slice(1) : rawToken
    return { start, end, rawToken, token }
  }

  function onRawTagInput() {
    clearTimeout(rawTagDebounceTimer)
    rawTagDebounceTimer = setTimeout(async () => {
      const { token } = rawTagTokenAtCursor()
      if (!token || token.includes(':')) {
        hideRawTagSuggestions()
        return
      }
      rawTagSuggestions.value = await tagsStore.autocomplete(token, tagAutocompleteOptions())
      rawTagSelectedIndex.value = rawTagSuggestions.value.length ? 0 : -1
    }, 150)
  }

  function tagAutocompleteOptions() {
    return {
      nameParts: localStorage.getItem(NAME_PART_AUTOCOMPLETE_KEY) === 'true',
      // The server only acts on this when booru suggestions are switched on.
      includeRemote: true,
    }
  }

  function selectRawTagSuggestion(tag) {
    if (!tag?.name) return
    tagsStore.rememberRemoteTag(tag)
    const { start, end, rawToken } = rawTagTokenAtCursor()
    const prefix = rawToken.startsWith('-') ? '-' : ''
    const before = rawEditedTags.value.slice(0, start)
    const after = rawEditedTags.value.slice(end)
    const inserted = `${prefix}${tag.name}`
    rawEditedTags.value = `${before}${inserted}${after}`
    hideRawTagSuggestions()
    requestAnimationFrame(() => {
      rawTagTextarea.value?.focus()
      const caret = before.length + inserted.length
      rawTagTextarea.value?.setSelectionRange(caret, caret)
    })
  }

  function onRawTagEnter(event) {
    if (!rawTagSuggestions.value.length) return
    event.preventDefault()
    const index = rawTagSelectedIndex.value >= 0 ? rawTagSelectedIndex.value : 0
    selectRawTagSuggestion(rawTagSuggestions.value[index])
  }

  function onRawTagArrowDown() {
    if (!rawTagSuggestions.value.length) return
    rawTagSelectedIndex.value = (rawTagSelectedIndex.value + 1) % rawTagSuggestions.value.length
  }

  function onRawTagArrowUp() {
    if (!rawTagSuggestions.value.length) return
    rawTagSelectedIndex.value = rawTagSelectedIndex.value <= 0
      ? rawTagSuggestions.value.length - 1
      : rawTagSelectedIndex.value - 1
  }

  function hideRawTagSuggestions() {
    rawTagSuggestions.value = []
    rawTagSelectedIndex.value = -1
  }

  function onRawTagBlur() {
    setTimeout(hideRawTagSuggestions, 150)
  }

  async function saveTags() {
    try {
      if (tagEditorMode.value === 'raw') {
        editedTags.value = parseRawTags(rawEditedTags.value)
      }
      // Carry the category/spelling of any tag picked from a remote booru
      // suggestion; the library has never seen it, so nothing else can.
      const meta = tagsStore.tagMetadataFor(editedTags.value)
      await api.updatePost(post.value.id, {
        tags: editedTags.value,
        tagCategories: meta.categories,
        tagDisplayNames: meta.displayNames,
      })
      await loadPost()
      showTagEditor.value = false
    } catch (e) {
      alert('Failed to save tags: ' + e.message)
    }
  }
  return {
    showTagEditor,
    editedTags,
    tagEditorMode,
    rawEditedTags,
    rawTagTextarea,
    rawTagSuggestions,
    rawTagSelectedIndex,
    openTagEditor,
    setTagEditorMode,
    clearEditedTags,
    parseRawTags,
    onRawTagInput,
    selectRawTagSuggestion,
    onRawTagEnter,
    onRawTagArrowDown,
    onRawTagArrowUp,
    hideRawTagSuggestions,
    onRawTagBlur,
    saveTags,
  }
}
