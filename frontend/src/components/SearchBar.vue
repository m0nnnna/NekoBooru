<template>
  <div class="search-bar">
    <input
      type="text"
      v-model="searchQuery"
      :placeholder="searchPlaceholder"
      @keydown.enter.prevent="onEnter"
      @keydown.down.prevent="onArrowDown"
      @keydown.up.prevent="onArrowUp"
      @input="onInput"
      @focus="inputFocused = true"
      @blur="inputFocused = false"
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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTagsStore } from '../stores/tags'
import { api } from '../api/client'

const router = useRouter()
const tagsStore = useTagsStore()

const searchQuery = ref('')
const suggestions = ref([])
const selectedIndex = ref(-1)
const inputFocused = ref(false)
const semanticSearchEnabled = ref(false)
const SEARCH_PREDICTION_KEY = 'nekobooru.searchPredictionEnabled'
const NAME_PART_AUTOCOMPLETE_KEY = 'nekobooru.namePartAutocompleteEnabled'
let debounceTimer = null
let autoRouteQuery = ''

const searchPlaceholder = computed(() =>
  semanticSearchEnabled.value ? 'Search tags or phrases~ nyaa' : 'Search tags~ nyaa'
)

onMounted(() => {
  loadSemanticSearchSetting()
  window.addEventListener('nekobooru:semantic-search-setting', onSemanticSearchSettingChanged)
})

onUnmounted(() => {
  clearTimeout(debounceTimer)
  window.removeEventListener('nekobooru:semantic-search-setting', onSemanticSearchSettingChanged)
})

async function loadSemanticSearchSetting() {
  try {
    const settings = await api.getAutoTagSettings()
    semanticSearchEnabled.value = settings.semanticSearchEnabled === true
  } catch (e) {
    semanticSearchEnabled.value = false
  }
}

function onSemanticSearchSettingChanged(event) {
  semanticSearchEnabled.value = event.detail?.enabled === true
}

function onInput() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(async () => {
    const words = searchQuery.value.split(' ')
    const lastWord = words[words.length - 1]
    if (lastWord && lastWord.length >= 1) {
      suggestions.value = await tagsStore.autocomplete(lastWord.replace('-', ''), autocompleteOptions())
      selectedIndex.value = -1
      applyAutomaticSearch()
    } else {
      suggestions.value = []
      selectedIndex.value = -1
    }
  }, 150)
}

function autocompleteOptions() {
  return {
    nameParts: localStorage.getItem(NAME_PART_AUTOCOMPLETE_KEY) === 'true',
  }
}

function selectTag(tag) {
  const words = searchQuery.value.split(' ')
  words[words.length - 1] = tag.name
  searchQuery.value = words.join(' ') + ' '
  suggestions.value = []
  selectedIndex.value = -1
  // Auto-search once a suggestion is chosen (click or arrow+enter)
  search()
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
  if (suggestions.value.length > 0) {
    const index = selectedIndex.value >= 0 ? selectedIndex.value : semanticSearchEnabled.value ? -1 : 0
    if (index >= 0) {
      selectTag(suggestions.value[index])
      return
    }
    search()
  } else {
    search()
  }
}

function applyAutomaticSearch() {
  if (localStorage.getItem(SEARCH_PREDICTION_KEY) !== 'true') return
  const query = semanticSearchEnabled.value ? searchQuery.value.trim() : predictedSearchQuery()
  if (!query || query === (router.currentRoute.value.query.q || '')) return
  autoRouteQuery = query
  router.push({ path: '/', query: { q: query } })
}

function predictedSearchQuery() {
  const top = suggestions.value[0]
  if (!top?.name) return ''
  const words = searchQuery.value.trimEnd().split(/\s+/)
  const lastWord = words[words.length - 1] || ''
  const plainWord = lastWord.startsWith('-') ? lastWord.slice(1) : lastWord
  if (!plainWord) return ''
  if (plainWord.includes(':') && top.name !== plainWord) return ''
  words[words.length - 1] = lastWord.startsWith('-') ? `-${top.name}` : top.name
  return words.join(' ').trim()
}

function search() {
  suggestions.value = []
  router.push({ path: '/', query: { q: searchQuery.value.trim() } })
}

// Sync with route query
watch(
  () => router.currentRoute.value.query.q,
  (q) => {
    if (inputFocused.value && q === autoRouteQuery) return
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
  flex-shrink: 1;
  min-width: 0;
}

.search-bar input {
  width: 100%;
  padding: 0.5rem 1rem;
  border: 1px solid var(--border);
  border-radius: 2rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.9rem;
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

@media (max-width: 768px) {
  .search-bar {
    width: auto;
    flex: 1;
    max-width: 200px;
  }

  .search-bar input {
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
  }

  .suggestions {
    position: fixed;
    top: 60px; /* below the sticky 60px header instead of 100% of the viewport */
    left: 0.5rem;
    right: 0.5rem;
    width: auto;
    max-height: 50vh;
  }
}

@media (max-width: 480px) {
  .search-bar {
    max-width: 150px;
  }

  .search-bar input {
    padding: 0.4rem 0.6rem;
    font-size: 0.8rem;
  }
}
</style>
