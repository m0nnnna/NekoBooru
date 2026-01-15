<template>
  <div class="tag-list">
    <h3 v-if="title">{{ title }}</h3>
    <div class="tags">
      <router-link
        v-for="tag in tags"
        :key="tag"
        :to="{ path: '/', query: { q: tag } }"
        class="tag"
        :style="{ '--tag-color': getTagColor(tag) }"
      >
        {{ tag }}
      </router-link>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  tags: {
    type: Array,
    required: true,
  },
  title: {
    type: String,
    default: '',
  },
  tagInfo: {
    type: Object,
    default: () => ({}),
  },
})

function getTagColor(tagName) {
  const info = props.tagInfo[tagName]
  return info?.categoryColor || 'var(--tag-general)'
}
</script>

<style scoped>
.tag-list h3 {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-bottom: 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.tag {
  display: inline-block;
  padding: 0.25rem 0.5rem;
  background: var(--bg-tertiary);
  border-radius: 0.25rem;
  font-size: 0.875rem;
  color: var(--text-primary);
  border-left: 3px solid var(--tag-color, var(--tag-general));
}

.tag:hover {
  background: var(--border);
}
</style>
