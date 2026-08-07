<template>
  <div class="tag-sidebar">
    <div v-for="group in groups" :key="group.category" class="tag-group">
      <h4 class="tag-group-heading" :style="{ color: group.color }">{{ group.label }}</h4>
      <ul class="tag-rows">
        <li v-for="tag in group.tags" :key="tag.name" class="tag-row">
          <router-link
            class="tag-wiki"
            :to="{ path: '/tags', query: { q: tag.name } }"
            :title="`Show ${displayName(tag)} in the tag list`"
          >?</router-link>
          <router-link
            class="tag-name"
            :style="{ color: group.color }"
            :to="{ path: '/', query: { q: tag.name } }"
            :title="tag.name"
          >{{ displayName(tag) }}</router-link>
          <span v-if="tag.usageCount" class="tag-count">{{ formatCount(tag.usageCount) }}</span>
        </li>
      </ul>
    </div>
    <p v-if="!groups.length" class="tag-empty">No tags yet.</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'

// Danbooru's sidebar order, with its display labels: the app stores "meta" and
// "general", which read as "Metadata" and "Tag".
const CATEGORY_ORDER = [
  { category: 'artist', label: 'Artist' },
  { category: 'character', label: 'Character' },
  { category: 'copyright', label: 'Copyright' },
  { category: 'meta', label: 'Metadata' },
  { category: 'general', label: 'Tag' },
]
const FALLBACK_COLOR = '#0075f8'

const props = defineProps({
  // [{ name, category, categoryColor, usageCount }] - post.tagDetails
  tags: {
    type: Array,
    default: () => [],
  },
})

const groups = computed(() => {
  const byCategory = new Map()
  for (const raw of props.tags) {
    const tag = typeof raw === 'string' ? { name: raw } : raw
    if (!tag?.name) continue
    const category = tag.category || 'general'
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category).push(tag)
  }

  // Known categories first in Danbooru order, then anything custom the user added.
  const known = CATEGORY_ORDER.map((entry) => entry.category)
  const extra = [...byCategory.keys()]
    .filter((category) => !known.includes(category))
    .sort()
    .map((category) => ({ category, label: category.replace(/[_-]+/g, ' ') }))

  return [...CATEGORY_ORDER, ...extra]
    .filter((entry) => byCategory.get(entry.category)?.length)
    .map((entry) => {
      const tags = byCategory.get(entry.category)
      return {
        category: entry.category,
        label: entry.label,
        color: tags.find((tag) => tag.categoryColor)?.categoryColor || FALLBACK_COLOR,
        tags: [...tags].sort((a, b) => a.name.localeCompare(b.name)),
      }
    })
})

function displayName(tag) {
  // Prefer the spelling the tagger reported, e.g. "miyu (blue archive)" for the
  // stored "miyu_blue_archive"; fall back to the readable flattened name.
  const entry = typeof tag === 'string' ? { name: tag } : (tag || {})
  return entry.displayName || String(entry.name || '').replace(/_/g, ' ')
}

function formatCount(count) {
  const value = Number(count) || 0
  if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 10000) return `${Math.round(value / 1000)}k`
  return String(value)
}
</script>

<style scoped>
.tag-sidebar {
  font-size: 0.85rem;
  line-height: 1.5;
}

.tag-group + .tag-group {
  margin-top: 0.85rem;
}

.tag-group-heading {
  margin: 0 0 0.2rem;
  font-size: 0.85rem;
  font-weight: 700;
}

.tag-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tag-row {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
}

.tag-wiki {
  flex: none;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 0.8rem;
}

.tag-wiki:hover {
  text-decoration: underline;
}

.tag-name {
  text-decoration: none;
  overflow-wrap: anywhere;
}

.tag-name:hover {
  text-decoration: underline;
}

.tag-count {
  margin-left: auto;
  flex: none;
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}

.tag-empty {
  color: var(--text-secondary);
  margin: 0;
}
</style>
