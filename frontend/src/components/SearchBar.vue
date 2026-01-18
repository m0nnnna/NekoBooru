<template>
  <div class="search-bar">
    <input
      type="text"
      v-model="searchQuery"
      placeholder="Search tags..."
      @keydown.enter.prevent="onEnter"
      @keydown.down.prevent="onArrowDown"
      @keydown.up.prevent="onArrowUp"
      @input="onInput"
    />
    <ul v-if="suggestions.length > 0" class="suggestions">
      <li
        v-for="(tag, index) in suggestions"
        :key="tag.name"
        @click="selectTag(tag)"
        @mouseenter="selectedIndex = index"
        :class="{ selected: index === selectedIndex }"
        :style="{ borderLeftColor: tag.categoryColor }"
      >
        <span class="tag-name">{{ tag.name }}</span>
        <span class="tag-count">{{ tag.usageCount }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTagsStore } from '../stores/tags'

const router = useRouter()
const tagsStore = useTagsStore()

const searchQuery = ref('')
const suggestions = ref([])
const selectedIndex = ref(-1)
let debounceTimer = null

function onInput() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(async () => {
    const words = searchQuery.value.split(' ')
    const lastWord = words[words.length - 1]
    if (lastWord && lastWord.length >= 1) {
      suggestions.value = await tagsStore.autocomplete(lastWord.replace('-', ''))
      selectedIndex.value = -1
    } else {
      suggestions.value = []
      selectedIndex.value = -1
    }
  }, 150)
}

function selectTag(tag) {
  const words = searchQuery.value.split(' ')
  words[words.length - 1] = tag.name
  searchQuery.value = words.join(' ') + ' '
  suggestions.value = []
  selectedIndex.value = -1
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

function onEnter() {
  if (suggestions.value.length > 0 && selectedIndex.value >= 0) {
    selectTag(suggestions.value[selectedIndex.value])
  } else {
    search()
  }
}

function search() {
  suggestions.value = []
  router.push({ path: '/', query: { q: searchQuery.value.trim() } })
}

// Sync with route query
watch(
  () => router.currentRoute.value.query.q,
  (q) => {
    if (q !== undefined) {
      searchQuery.value = q
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.search-bar {
  position: relative;
  width: 300px;
}

.search-bar input {
  width: 100%;
  padding: 0.5rem 1rem;
  border: 1px solid var(--border);
  border-radius: 2rem;
  background: var(--bg-primary);
  color: var(--text-primary);
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
  max-height: 300px;
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
</style>
