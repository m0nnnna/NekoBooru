<template>
  <BatchCard
    class="batch-inspector"
    title="Hovered Post Details"
    description="Inspect tags and metadata before chaining another batch operation."
  >
    <div v-if="post" class="inspector-body">
      <img :src="post.thumbUrl" :alt="post.filename" class="inspector-thumb" />
      <div class="inspector-meta">
        <div>
          <strong>#{{ post.id }}</strong>
          <span class="safety-pill" :class="post.safety">{{ post.safety }}</span>
        </div>
        <dl>
          <dt>Type</dt>
          <dd>{{ post.extension || 'unknown' }}</dd>
          <dt>Size</dt>
          <dd>{{ post.width || '?' }} x {{ post.height || '?' }}</dd>
          <dt>File</dt>
          <dd>{{ formatFileSize(post.fileSize) }}</dd>
          <template v-if="post.source">
            <dt>Source</dt>
            <dd :title="post.source">{{ truncateText(post.source, 54) }}</dd>
          </template>
        </dl>
      </div>
      <div v-if="semanticLoading || semanticAnalysis" class="inspector-semantic">
        <div>
          <strong>Semantic Description</strong>
          <small v-if="semanticAnalysis">
            {{ semanticAnalysis.model }}{{ semanticAnalysis.timing ? ` · ${semanticAnalysis.timing}` : '' }}
          </small>
          <small v-else>Loading...</small>
        </div>
        <p v-if="semanticAnalysis">{{ semanticAnalysis.description }}</p>
        <div v-if="semanticAnalysis?.tags.length" class="inspector-tag-list semantic-tags">
          <span v-for="tag in semanticAnalysis.tags" :key="tag">{{ tag }}</span>
        </div>
      </div>
      <div class="inspector-tags">
        <div>
          <strong>{{ post.tags?.length || 0 }} tags</strong>
          <small>Hover another post to inspect it.</small>
        </div>
        <div v-if="post.tags?.length" class="inspector-tag-list">
          <span v-for="tag in post.tags" :key="tag">{{ tag }}</span>
        </div>
        <p v-else class="batch-note">No tags on this post.</p>
      </div>
    </div>
    <p v-else class="batch-note">Hover a post while edit mode is active to inspect it here.</p>
  </BatchCard>
</template>

<script setup>
import BatchCard from './BatchCard.vue'
import { formatFileSize, truncateText } from '../../utils/format'

defineProps({
  post: {
    type: Object,
    default: null,
  },
  semanticAnalysis: {
    type: Object,
    default: null,
  },
  semanticLoading: {
    type: Boolean,
    default: false,
  },
})
</script>

<style scoped>
.batch-inspector {
  overflow: hidden;
}

.inspector-body {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 0.75rem;
  margin-top: 0.85rem;
}

.inspector-thumb {
  width: 96px;
  height: 96px;
  border-radius: 0.5rem;
  object-fit: cover;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
}

.inspector-meta {
  min-width: 0;
}

.inspector-meta > div:first-child {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.safety-pill {
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
}

.safety-pill.safe {
  background: rgba(74, 222, 128, 0.18);
  color: #86efac;
}

.safety-pill.sketchy {
  background: rgba(250, 204, 21, 0.18);
  color: #fde047;
}

.safety-pill.unsafe {
  background: rgba(248, 113, 113, 0.18);
  color: #fca5a5;
}

.inspector-meta dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.25rem 0.65rem;
  margin: 0;
  font-size: 0.85rem;
}

.inspector-meta dt {
  color: var(--text-secondary);
}

.inspector-meta dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspector-semantic {
  grid-column: 1 / -1;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}

.inspector-semantic > div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 0.5rem;
}

.inspector-semantic strong {
  color: var(--accent);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.74rem;
}

.inspector-semantic small {
  text-align: right;
}

.inspector-semantic p {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.86rem;
  line-height: 1.45;
  max-height: 7.4rem;
  overflow-y: auto;
  padding-right: 0.25rem;
}

.inspector-tag-list.semantic-tags {
  margin-top: 0.6rem;
  max-height: 70px;
}

.inspector-tags {
  grid-column: 1 / -1;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}

.inspector-tags > div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 0.55rem;
}

.inspector-tags > div:first-child strong {
  color: var(--text-primary);
}

.inspector-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  max-height: 132px;
  overflow-y: auto;
  padding-right: 0.25rem;
}

.inspector-tag-list span {
  border: 1px solid var(--accent);
  border-radius: 0.35rem;
  color: var(--accent);
  background: rgba(96, 165, 250, 0.1);
  padding: 0.2rem 0.45rem;
  font-size: 0.8rem;
}

@media (max-width: 768px) {
  .inspector-body {
    grid-template-columns: 72px minmax(0, 1fr);
  }

  .inspector-thumb {
    width: 72px;
    height: 72px;
  }
}
</style>

<style scoped src="./batchForms.css"></style>
