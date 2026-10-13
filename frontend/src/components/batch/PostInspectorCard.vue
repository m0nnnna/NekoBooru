<template>
  <BatchCard
    class="batch-inspector"
    title="Hovered Post Details"
    description="Inspect tags and metadata before chaining another batch operation."
  >
    <div v-if="post" class="inspector-body">
      <img :src="post.thumbUrl" :alt="post.filename" class="inspector-thumb" />
      <div class="inspector-meta">
        <div class="inspector-id-row">
          <a
            class="inspector-id"
            :href="`/post/${post.id}`"
            target="_blank"
            rel="noopener"
            title="Open this post in a new tab"
          >#{{ post.id }}</a>
          <span class="safety-pill" :class="post.safety">{{ post.safety }}</span>
        </div>
        <dl class="inspector-props">
          <div>
            <dt>Type</dt>
            <dd>{{ post.extension || 'unknown' }}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{{ post.width || '?' }} × {{ post.height || '?' }}</dd>
          </div>
          <div>
            <dt>File</dt>
            <dd>{{ formatFileSize(post.fileSize) }}</dd>
          </div>
          <div v-if="post.filename">
            <dt>Name</dt>
            <dd :title="post.filename">{{ post.filename }}</dd>
          </div>
          <div v-if="post.source">
            <dt>Source</dt>
            <dd :title="post.source">
              <a
                v-if="isLink(post.source)"
                :href="post.source"
                target="_blank"
                rel="noopener noreferrer"
              >{{ post.source }}</a>
              <template v-else>{{ post.source }}</template>
            </dd>
          </div>
        </dl>
      </div>

      <section v-if="semanticLoading || semanticAnalysis" class="inspector-section">
        <header>
          <h4>Semantic description</h4>
          <small v-if="semanticAnalysis">
            {{ semanticAnalysis.model }}{{ semanticAnalysis.timing ? ` · ${semanticAnalysis.timing}` : '' }}
          </small>
          <small v-else>Loading...</small>
        </header>
        <p v-if="semanticAnalysis" class="inspector-semantic-text">{{ semanticAnalysis.description }}</p>
        <div v-if="semanticAnalysis?.tags.length" class="inspector-tag-list semantic-tags">
          <span v-for="tag in semanticAnalysis.tags" :key="tag">{{ tag }}</span>
        </div>
      </section>

      <section class="inspector-section">
        <header>
          <h4>Tags <span class="inspector-count">{{ post.tags?.length || 0 }}</span></h4>
          <small>Hover another post to inspect it.</small>
        </header>
        <div v-if="post.tags?.length" class="inspector-tag-list">
          <span v-for="tag in post.tags" :key="tag">{{ tag }}</span>
        </div>
        <p v-else class="batch-note">No tags on this post.</p>
      </section>
    </div>
    <p v-else class="inspector-empty">Hover a post while edit mode is active to inspect it here.</p>
  </BatchCard>
</template>

<script setup>
import BatchCard from './BatchCard.vue'
import { formatFileSize } from '../../utils/format'

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

function isLink(value) {
  return /^https?:\/\//i.test(String(value || ''))
}
</script>

<style scoped>
.inspector-body {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 0.85rem;
}

.inspector-thumb {
  width: 88px;
  height: 88px;
  border-radius: 0.5rem;
  object-fit: cover;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
}

.inspector-meta {
  display: grid;
  align-content: start;
  gap: 0.45rem;
  min-width: 0;
}

.inspector-id-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.inspector-id {
  color: var(--text-primary);
  font-size: 0.95rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.inspector-id:hover {
  color: var(--accent);
}

.safety-pill {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.safety-pill.safe {
  background: color-mix(in srgb, var(--success) 20%, transparent);
  color: color-mix(in srgb, var(--success) 65%, var(--text-primary));
}

.safety-pill.sketchy {
  background: color-mix(in srgb, var(--warning) 25%, transparent);
  color: color-mix(in srgb, var(--warning) 55%, var(--text-primary));
}

.safety-pill.unsafe {
  background: color-mix(in srgb, var(--coral) 20%, transparent);
  color: color-mix(in srgb, var(--coral) 70%, var(--text-primary));
}

.inspector-props {
  display: grid;
  gap: 0.2rem;
  margin: 0;
}

.inspector-props > div {
  display: grid;
  grid-template-columns: 3.75rem minmax(0, 1fr);
  align-items: baseline;
  gap: 0.5rem;
}

.inspector-props dt {
  color: var(--text-secondary);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.inspector-props dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.84rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspector-props dd a {
  color: var(--accent);
}

.inspector-props dd a:hover {
  color: var(--accent-hover);
  text-decoration: underline;
}

.inspector-section {
  grid-column: 1 / -1;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.inspector-section > header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.inspector-section h4 {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.inspector-count {
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 0.7rem;
  letter-spacing: 0;
}

.inspector-section small {
  color: var(--text-secondary);
  font-size: 0.74rem;
  text-align: right;
}

.inspector-semantic-text {
  margin: 0;
  max-height: 7.4rem;
  overflow-y: auto;
  padding-right: 0.25rem;
  color: var(--text-primary);
  font-size: 0.84rem;
  line-height: 1.5;
}

.inspector-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  max-height: 132px;
  overflow-y: auto;
  padding-right: 0.25rem;
}

.inspector-tag-list.semantic-tags {
  margin-top: 0.6rem;
  max-height: 70px;
}

.inspector-tag-list span {
  padding: 0.15rem 0.5rem;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 999px;
  background: var(--accent-soft);
  color: color-mix(in srgb, var(--accent) 75%, var(--text-primary));
  font-size: 0.76rem;
  line-height: 1.4;
}

.inspector-empty {
  margin: 0;
  padding: 1.1rem 0.75rem;
  border: 1px dashed var(--border);
  border-radius: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  text-align: center;
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
