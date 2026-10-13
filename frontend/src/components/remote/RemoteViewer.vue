<template>
  <Teleport :to="teleportTarget">
    <div class="remote-viewer" role="dialog" aria-modal="true" :aria-label="`${siteLabel} post ${post.id}`">
      <div class="remote-viewer-media">
        <MediaViewer
          v-if="media.src"
          :key="post.key"
          :src="media.src"
          :type="media.type"
          :alt="`${siteLabel} #${post.id}`"
          no-referrer
          @close="$emit('close')"
        />
        <div v-else class="remote-viewer-missing">
          <p>{{ siteLabel }} #{{ post.id }} has no file to show.</p>
          <button type="button" class="btn btn-secondary" @click="$emit('close')">Close</button>
        </div>
        <button
          v-if="hasPrev"
          type="button"
          class="viewer-nav prev"
          title="Previous post (Left arrow)"
          aria-label="Previous post"
          @click="$emit('navigate', -1)"
        >&#8249;</button>
        <button
          v-if="hasNext"
          type="button"
          class="viewer-nav next"
          title="Next post (Right arrow)"
          aria-label="Next post"
          @click="$emit('navigate', 1)"
        >&#8250;</button>
      </div>

      <aside class="remote-viewer-panel">
        <header class="panel-head">
          <span class="site-pill">{{ siteLabel }}</span>
          <a class="post-id" :href="post.postUrl" target="_blank" rel="noopener noreferrer" title="Open on the booru">#{{ post.id }}</a>
          <span class="safety-pill" :class="post.safety">{{ post.safety }}</span>
        </header>

        <div class="panel-actions">
          <router-link
            v-if="inLibraryPostId"
            class="btn btn-secondary btn-sm"
            :to="`/post/${inLibraryPostId}`"
          >In library &#8594; open</router-link>
          <button
            v-else-if="importable"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="!post.fileUrl"
            :title="post.fileUrl ? 'Import this post into NekoBooru' : 'The booru does not offer the original file'"
            @click="$emit('import', post)"
          >Import</button>
          <a class="btn btn-secondary btn-sm" :href="post.postUrl" target="_blank" rel="noopener noreferrer">
            View on {{ siteLabel }}
          </a>
        </div>

        <dl class="panel-props">
          <div>
            <dt>Size</dt>
            <dd>{{ post.width || '?' }} &#215; {{ post.height || '?' }}</dd>
          </div>
          <div>
            <dt>File</dt>
            <dd>{{ post.fileExt || 'unknown' }} · {{ formatFileSize(post.fileSize) }}</dd>
          </div>
          <div v-if="post.rawRating">
            <dt>Rating</dt>
            <dd>{{ post.rawRating }}</dd>
          </div>
          <div v-if="post.score !== null && post.score !== undefined">
            <dt>Score</dt>
            <dd>{{ post.score }}</dd>
          </div>
          <div v-if="post.unavailable">
            <dt>Status</dt>
            <dd>{{ post.unavailable }}</dd>
          </div>
          <div v-if="post.source">
            <dt>Source</dt>
            <dd :title="post.source">
              <a v-if="isLink(post.source)" :href="post.source" target="_blank" rel="noopener noreferrer">{{ post.source }}</a>
              <template v-else>{{ post.source }}</template>
            </dd>
          </div>
        </dl>

        <section v-for="group in tagGroups" :key="group.category" class="tag-group">
          <h4>{{ group.title }} <span class="tag-count">{{ group.tags.length }}</span></h4>
          <ul>
            <li v-for="tag in group.tags" :key="tag.name" :class="`tag-${group.category}`" :title="tag.name">
              {{ tag.label }}
            </li>
          </ul>
        </section>
        <p v-if="!tagGroups.length" class="panel-note">No tags on this post.</p>
      </aside>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import MediaViewer from '../MediaViewer.vue'
import { siteById } from '../../remote/types.js'
import { formatFileSize } from '../../utils/format'

// Full-screen viewer for one booru post (section 4.5 of
// docs/booru-search-plan.md): the original loaded straight from the booru
// without a Referer, and a side panel with its tags by category. Escape
// closes (MediaViewer handles it), the arrow keys step through the section.
const TAG_GROUPS = [
  ['character', 'Characters'],
  ['copyright', 'Copyrights'],
  ['artist', 'Artists'],
  ['general', 'General'],
  ['meta', 'Meta'],
]

const props = defineProps({
  post: { type: Object, required: true },
  inLibraryPostId: { type: Number, default: null },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  // Shows the Import button; the import queue (P4b) handles `import`.
  importable: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'navigate', 'import'])

// Inside #app when it exists, so the dark-mode colour variables apply.
const teleportTarget = typeof document !== 'undefined' && document.querySelector('#app') ? '#app' : 'body'

const siteLabel = computed(() => siteById(props.post.site)?.label || props.post.site)

// Videos play from the original (ugoira zips cannot); everything else shows
// the original image, else the sample, else the grid preview.
const media = computed(() => {
  const post = props.post
  if (post.mediaType === 'video' && post.fileUrl && post.fileExt !== 'zip') return { src: post.fileUrl, type: 'video' }
  const original = post.mediaType === 'video' ? null : post.fileUrl
  return { src: original || post.sampleUrl || post.thumbUrl || '', type: 'image' }
})

const tagGroups = computed(() => {
  const categories = props.post.tagCategories || {}
  const names = props.post.tagDisplayNames || {}
  return TAG_GROUPS
    .map(([category, title]) => ({
      category,
      title,
      tags: (props.post.tags || [])
        .filter((tag) => (categories[tag] || 'general') === category)
        .map((tag) => ({ name: tag, label: names[tag] || tag.replace(/_/g, ' ') })),
    }))
    .filter((group) => group.tags.length)
})

function isLink(value) {
  return /^https?:\/\//i.test(String(value || ''))
}

function onKeyDown(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  const target = event.target
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
  if (event.key === 'ArrowLeft' && props.hasPrev) emit('navigate', -1)
  else if (event.key === 'ArrowRight' && props.hasNext) emit('navigate', 1)
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
</script>

<style scoped>
.remote-viewer {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  background: #000;
}

.remote-viewer-media {
  position: relative;
  min-width: 0;
  min-height: 0;
}

.remote-viewer-media :deep(.media-viewer) {
  border-radius: 0;
  background: #000;
  height: 100%;
}

.remote-viewer-missing {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: #ddd;
}

.viewer-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  width: 44px;
  height: 64px;
  border: none;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.45);
  color: white;
  font-size: 2rem;
  cursor: pointer;
}

.viewer-nav:hover {
  background: rgba(0, 0, 0, 0.7);
}

.viewer-nav.prev {
  left: 0.75rem;
}

.viewer-nav.next {
  right: 0.75rem;
}

.remote-viewer-panel {
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  border-left: 1px solid var(--border);
}

.panel-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.site-pill,
.safety-pill {
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  background: var(--bg-tertiary);
}

.safety-pill.safe { background: #4ade80; color: #10301b; }
.safety-pill.sketchy { background: #facc15; color: #3a2f00; }
.safety-pill.unsafe { background: #f87171; color: #3b0b0b; }

.post-id {
  font-weight: 700;
  color: var(--accent);
}

.panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.panel-props {
  display: grid;
  gap: 0.3rem;
  font-size: 0.85rem;
}

.panel-props div {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  gap: 0.5rem;
}

.panel-props dt {
  color: var(--text-muted);
}

.panel-props dd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-group h4 {
  font-size: 0.85rem;
  margin-bottom: 0.35rem;
  color: var(--text-secondary);
}

.tag-count {
  color: var(--text-muted);
  font-weight: 400;
}

.tag-group ul {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.tag-group li {
  padding: 0.15rem 0.45rem;
  border-radius: 0.35rem;
  font-size: 0.8rem;
  background: var(--bg-secondary);
  color: var(--tag-general);
}

.tag-group li.tag-character { color: var(--tag-character); }
.tag-group li.tag-copyright { color: var(--tag-copyright); }
.tag-group li.tag-artist { color: var(--tag-artist); }
.tag-group li.tag-meta { color: var(--tag-meta); }

.panel-note {
  color: var(--text-muted);
  font-size: 0.85rem;
}

@media (max-width: 768px) {
  .remote-viewer {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(0, 40vh);
  }

  .remote-viewer-panel {
    border-left: none;
    border-top: 1px solid var(--border);
  }
}
</style>
