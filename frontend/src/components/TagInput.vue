<template>
  <div class="tag-input">
    <div class="tags-display" v-if="modelValue.length > 0">
      <span
        v-for="tag in modelValue"
        :key="tag"
        class="tag"
      >
        {{ tag }}
        <button @click="removeTag(tag)" class="remove-tag">&times;</button>
      </span>
    </div>
    <div class="input-wrapper">
      <input
        type="text"
        v-model="inputValue"
        :placeholder="placeholder"
        @keydown.enter.prevent="onEnter"
        @keydown.backspace="onBackspace"
        @keydown.down.prevent="onArrowDown"
        @keydown.up.prevent="onArrowUp"
        @input="onInput"
        @blur="onBlur"
      />
      <ul v-if="suggestions.length > 0" class="suggestions">
        <li
          v-for="(tag, index) in suggestions"
          :key="tag.name"
          @mousedown.prevent="selectSuggestion(tag)"
          @mouseenter="selectedIndex = index"
          :class="{ selected: index === selectedIndex }"
          :style="{ borderLeftColor: tag.categoryColor }"
        >
          <span class="tag-name">
            {{ tag.name }}
            <em v-if="tag.remote" class="tag-category">{{ tag.category }}</em>
          </span>
          <span v-if="tag.remote" class="tag-count remote" :title="`Not in your library. ${tag.remoteCount} posts on ${tag.source}.`">
            {{ tag.source }} {{ formatRemoteCount(tag.remoteCount) }}
          </span>
          <span v-else class="tag-count">{{ tag.usageCount }}</span>
        </li>
      </ul>
    </div>
    <div class="hint">Separate tags with commas or press Enter</div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useTagsStore } from '../stores/tags'

const props = defineProps({
  modelValue: {
    type: Array,
    required: true,
  },
  placeholder: {
    type: String,
    default: 'Add tags (comma separated)...',
  },
})

const emit = defineEmits(['update:modelValue'])
const tagsStore = useTagsStore()

const inputValue = ref('')
const suggestions = ref([])
const selectedIndex = ref(-1)
const NAME_PART_AUTOCOMPLETE_KEY = 'nekobooru.namePartAutocompleteEnabled'
let debounceTimer = null

function processTagString(str) {
  // Split by comma, clean up each tag
  return str
    .split(',')
    .map(t => t.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(t => t.length > 0)
}

function addCurrentTag() {
  if (!inputValue.value.trim()) return

  const newTags = processTagString(inputValue.value)
  const currentTags = [...props.modelValue]

  for (const tag of newTags) {
    if (tag && !currentTags.includes(tag)) {
      currentTags.push(tag)
    }
  }

  emit('update:modelValue', currentTags)
  inputValue.value = ''
  suggestions.value = []
}

function onInput() {
  // Check if user typed a comma - if so, process tags so far
  if (inputValue.value.includes(',')) {
    const parts = inputValue.value.split(',')
    const lastPart = parts.pop() // Keep the part after the last comma
    const tagsToAdd = parts.map(t => t.trim().toLowerCase().replace(/\s+/g, '_')).filter(t => t.length > 0)

    if (tagsToAdd.length > 0) {
      const currentTags = [...props.modelValue]
      for (const tag of tagsToAdd) {
        if (!currentTags.includes(tag)) {
          currentTags.push(tag)
        }
      }
      emit('update:modelValue', currentTags)
    }

    inputValue.value = lastPart
  }

  // Autocomplete
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(async () => {
    const query = inputValue.value.trim()
    if (query.length >= 1) {
      suggestions.value = await tagsStore.autocomplete(query, autocompleteOptions())
      selectedIndex.value = -1
    } else {
      suggestions.value = []
      selectedIndex.value = -1
    }
  }, 150)
}

function removeTag(tag) {
  emit('update:modelValue', props.modelValue.filter(t => t !== tag))
}

function onBackspace() {
  if (!inputValue.value && props.modelValue.length > 0) {
    const newTags = [...props.modelValue]
    newTags.pop()
    emit('update:modelValue', newTags)
  }
}

function selectSuggestion(tag) {
  // Remember the source board's category before the tag becomes a bare name.
  tagsStore.rememberRemoteTag(tag)
  if (!props.modelValue.includes(tag.name)) {
    emit('update:modelValue', [...props.modelValue, tag.name])
  }
  inputValue.value = ''
  suggestions.value = []
  selectedIndex.value = -1
}

function onEnter() {
  if (suggestions.value.length > 0 && selectedIndex.value >= 0) {
    selectSuggestion(suggestions.value[selectedIndex.value])
  } else {
    addCurrentTag()
  }
}

function onBlur() {
  // Delay to allow click on suggestion to register
  setTimeout(() => {
    suggestions.value = []
    selectedIndex.value = -1
  }, 150)
  addCurrentTag()
}

function onArrowDown() {
  if (suggestions.value.length > 0) {
    selectedIndex.value = (selectedIndex.value + 1) % suggestions.value.length
  }
}

function onArrowUp() {
  if (suggestions.value.length > 0) {
    selectedIndex.value = selectedIndex.value <= 0
      ? suggestions.value.length - 1
      : selectedIndex.value - 1
  }
}

function autocompleteOptions() {
  return {
    nameParts: localStorage.getItem(NAME_PART_AUTOCOMPLETE_KEY) === 'true',
    // The server only acts on this when booru suggestions are switched on.
    includeRemote: true,
  }
}

// The board's post count, not yours - abbreviated so it cannot be mistaken for
// a local usage count sitting in the same column.
function formatRemoteCount(count) {
  const value = Number(count) || 0
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}
</script>

<style scoped>
.tag-input {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.5rem;
  background: var(--bg-primary);
}

.tags-display {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  background: var(--accent-soft);
  border-radius: 0.25rem;
  font-size: 0.875rem;
  color: var(--accent);
  border: 1px solid var(--accent);
}

.remove-tag {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 1rem;
  padding: 0;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
}

.remove-tag:hover {
  opacity: 1;
  color: var(--coral);
}

.input-wrapper {
  position: relative;
}

.input-wrapper input {
  width: 100%;
  border: none;
  background: transparent;
  padding: 0.25rem;
  color: var(--text-primary);
}

.input-wrapper input:focus {
  outline: none;
}

.hint {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 0.25rem;
}

.suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  margin-top: 0.25rem;
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
  z-index: 100;
  box-shadow: 0 4px 12px var(--shadow);
}

.suggestions li {
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  border-left: 3px solid transparent;
  color: var(--text-primary);
}

.suggestions li:hover,
.suggestions li.selected {
  background: var(--bg-tertiary);
}

.tag-count {
  color: var(--text-secondary);
  font-size: 0.875rem;
}

/* Remote rows: a tag you do not have yet, offered by a public booru. The
   category is spelled out because that is the reason to pick it, and the count
   is theirs, not yours. */
.tag-category {
  margin-left: 0.4rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-style: normal;
  opacity: 0.85;
}

.tag-count.remote {
  font-size: 0.75rem;
  opacity: 0.8;
  white-space: nowrap;
}
</style>
