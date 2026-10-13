<template>
  <section class="sidebar-section post-tools">
    <div class="post-tools-tabs" role="tablist" aria-label="Post tools">
      <button
        v-for="tab in postToolTabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="post-tools-tab"
        :class="{ active: activePostToolTab === tab.id }"
        :aria-selected="activePostToolTab === tab.id"
        @click="selectPostToolTab(tab.id)"
      >
        {{ tab.label }}
        <span v-if="tab.busy" class="post-tools-busy" aria-label="working"></span>
      </button>
    </div>

    <PostAiTagPanel
      v-if="autoTagControlsVisible"
      v-show="activePostToolTab === 'ai'"
      :auto-tag="autoTag"
      :media-type="mediaType"
    />

    <div v-show="activePostToolTab === 'similar'" class="post-tools-panel" role="tabpanel">
      <button class="btn btn-secondary similar-btn" @click="loadSimilar" :disabled="similarLoading">
        {{ similarLoading ? 'Searching...' : 'Find Similar' }}
      </button>
      <div v-if="similarLoaded && !similar.length" class="similar-empty">
        No visually similar posts found.
      </div>
      <div v-if="similar.length" class="similar-grid">
        <router-link
          v-for="item in similar"
          :key="item.post.id"
          :to="`/post/${item.post.id}`"
          class="similar-thumb"
          :title="`distance ${item.distance}`"
        >
          <img :src="item.post.thumbUrl" :alt="item.post.filename" loading="lazy" />
        </router-link>
      </div>
    </div>

    <PostOnlineSearchPanel
      v-show="activePostToolTab === 'search'"
      :search="search"
      :media-type="mediaType"
    />

    <PostOptimizePanel
      v-show="activePostToolTab === 'optimize'"
      :post="post"
      :optimize="optimize"
    />
  </section>
</template>

<script setup>
import PostAiTagPanel from './PostAiTagPanel.vue'
import PostOnlineSearchPanel from './PostOnlineSearchPanel.vue'
import PostOptimizePanel from './PostOptimizePanel.vue'

const props = defineProps({
  post: {
    type: Object,
    required: true,
  },
  mediaType: {
    type: String,
    default: 'image',
  },
  // The objects returned by usePostPageLayout(), usePostPageAutoTag(),
  // usePostPageSearch() and usePostPageOptimize().
  layout: {
    type: Object,
    required: true,
  },
  autoTag: {
    type: Object,
    required: true,
  },
  search: {
    type: Object,
    required: true,
  },
  optimize: {
    type: Object,
    required: true,
  },
})

const { postToolTabs, activePostToolTab, selectPostToolTab } = props.layout
const { autoTagControlsVisible } = props.autoTag
const { similar, similarLoading, similarLoaded, loadSimilar } = props.search
</script>

<style scoped>
.post-tools {
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-primary);
  overflow: hidden;
  /* The sidebar is a scrolling flex column; without this the clipped box shrinks to nothing. */
  flex-shrink: 0;
}

.post-tools-tabs {
  display: grid;
  grid-auto-columns: minmax(0, 1fr);
  grid-auto-flow: column;
  gap: 0.25rem;
  padding: 0.3rem;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
}

.post-tools-tab {
  position: relative;
  min-width: 0;
  padding: 0.45rem 0.25rem;
  border: none;
  border-radius: 0.45rem;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.post-tools-tab:hover {
  color: var(--text-primary);
}

.post-tools-tab.active {
  background: var(--bg-secondary);
  color: var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
}

.post-tools-busy {
  position: absolute;
  top: 0.3rem;
  right: 0.3rem;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: post-tools-pulse 1s ease-in-out infinite;
}

@keyframes post-tools-pulse {
  50% {
    opacity: 0.3;
  }
}

.post-tools-panel {
  padding: 0.85rem;
}

.post-tools-panel > :first-child {
  margin-top: 0;
}

.similar-btn {
  width: 100%;
}

.similar-empty {
  margin-top: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.similar-grid {
  margin-top: 0.75rem;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.4rem;
}

.similar-thumb {
  display: block;
  aspect-ratio: 1;
  border-radius: 0.4rem;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.similar-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

</style>
