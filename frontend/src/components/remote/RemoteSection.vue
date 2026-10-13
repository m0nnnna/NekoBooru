<template>
  <section class="remote-section" :aria-label="`${section.label} results`">
    <header class="remote-section-header">
      <div class="section-title">
        <h2>{{ section.label }}</h2>
        <span class="section-count">{{ countLabel(section) }}</span>
        <span v-if="pageLabel(section)" class="section-pages">· {{ pageLabel(section) }}</span>
        <span v-if="section.loading && !waitingLabel(section)" class="section-loading">Loading...</span>
      </div>
      <div class="section-notes">
        <p v-if="section.note" class="section-note">{{ section.note }}</p>
        <p v-if="ignoredLabel(section)" class="section-note">{{ ignoredLabel(section) }}</p>
        <p v-if="filteredLabel(section)" class="section-note">{{ filteredLabel(section) }}</p>
        <p v-if="waitingLabel(section)" class="section-note waiting">{{ waitingLabel(section) }}</p>
        <p v-if="section.error" class="section-error" role="alert">
          {{ errorLabel(section) }}
          <button type="button" class="btn btn-secondary btn-sm" :disabled="section.loading" @click="$emit('retry', section.site)">
            Retry
          </button>
        </p>
      </div>
    </header>

    <div v-if="section.posts.length" class="remote-grid">
      <RemotePostCard
        v-for="post in section.posts"
        :key="post.key"
        :post="post"
        :select-mode="selectMode"
        :selected="selectedKeys.has(post.key)"
        :in-library-post-id="inLibraryPostId(post)"
        @toggle="$emit('toggle', $event)"
        @hold-select="$emit('hold-select', $event)"
        @hover-post="$emit('hover-post', $event)"
        @open="$emit('open', $event)"
      />
    </div>
    <p v-else-if="section.loading" class="section-empty">Searching {{ section.label }}...</p>
    <p v-else-if="!section.error" class="section-empty">No posts found on {{ section.label }}.</p>

    <footer v-if="section.cursor" class="remote-section-footer">
      <button
        type="button"
        class="btn btn-secondary load-more"
        :disabled="!canLoadMore(section)"
        @click="$emit('load-more', section.site)"
      >
        {{ section.loading ? 'Loading...' : 'Load more' }}
      </button>
    </footer>
  </section>
</template>

<script setup>
import RemotePostCard from './RemotePostCard.vue'
import {
  canLoadMore,
  countLabel,
  errorLabel,
  filteredLabel,
  ignoredLabel,
  pageLabel,
  waitingLabel,
} from '../../remote/sectionStatus.js'

// One booru's results in grouped mode: header (count, pages, notes, error
// with Retry, rate-limit wait), the card grid, and "Load more".
defineProps({
  site: { type: String, required: true },
  section: { type: Object, required: true },
  selectMode: { type: Boolean, default: false },
  selectedKeys: { type: Set, default: () => new Set() },
  inLibraryPostId: { type: Function, default: () => null },
})

defineEmits(['load-more', 'retry', 'toggle', 'hold-select', 'hover-post', 'open'])
</script>

<style scoped src="./remoteGrid.css"></style>

<style scoped>
.remote-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.remote-section-header {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.section-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.5rem;
  color: var(--text-secondary);
}

.section-title h2 {
  font-size: 1.1rem;
  color: var(--text-primary);
}

.section-loading {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.section-notes {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.section-note {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.section-note.waiting {
  color: var(--warning);
}

.section-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  color: var(--coral);
  font-size: 0.9rem;
}

.section-empty {
  color: var(--text-secondary);
  text-align: center;
  padding: 1.5rem;
}

.remote-section-footer {
  display: flex;
  justify-content: center;
}
</style>
