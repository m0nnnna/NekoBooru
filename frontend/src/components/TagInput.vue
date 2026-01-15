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
        @keydown.enter.prevent="addCurrentTag"
        @keydown.backspace="onBackspace"
        @input="onInput"
        @blur="addCurrentTag"
      />
      <ul v-if="suggestions.length > 0" class="suggestions">
        <li
          v-for="tag in suggestions"
          :key="tag.name"
          @mousedown.prevent="selectSuggestion(tag)"
          :style="{ borderLeftColor: tag.categoryColor }"
        >
          <span class="tag-name">{{ tag.name }}</span>
          <span class="tag-count">{{ tag.usageCount }}</span>
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
      suggestions.value = await tagsStore.autocomplete(query)
    } else {
      suggestions.value = []
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
  if (!props.modelValue.includes(tag.name)) {
    emit('update:modelValue', [...props.modelValue, tag.name])
  }
  inputValue.value = ''
  suggestions.value = []
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
}

.suggestions li:hover {
  background: var(--bg-tertiary);
}

.tag-count {
  color: var(--text-secondary);
  font-size: 0.875rem;
}
</style>
