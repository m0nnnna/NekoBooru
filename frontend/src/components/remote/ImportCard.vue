<template>
  <BatchCard
    class="import-card"
    title="Import from boorus"
    :description="description"
    :open="open"
  >
    <fieldset class="import-options" :disabled="running">
      <label class="batch-check">
        <input v-model="options.autoTag" type="checkbox" data-test="auto-tag" />
        <span>
          <strong>Auto-tag after import</strong>
          <small>Run the AI tagger on each imported post. Off keeps only the booru's own tags.</small>
        </span>
      </label>
      <div class="batch-field-grid compact">
        <label>
          Safety
          <select v-model="options.safetyOverride" data-test="safety">
            <option value="">Keep the site's rating</option>
            <option value="safe">Safe</option>
            <option value="sketchy">Sketchy</option>
            <option value="unsafe">Unsafe / NSFW</option>
          </select>
        </label>
        <label>
          Pool
          <select v-model="options.poolId" data-test="pool">
            <option :value="null">No pool</option>
            <option v-for="pool in pools" :key="pool.id" :value="pool.id">{{ pool.name }}</option>
            <option :value="NEW_POOL">Create new pool…</option>
          </select>
        </label>
        <label v-if="options.poolId === NEW_POOL">
          New pool name
          <input
            v-model="options.newPoolName"
            type="text"
            maxlength="200"
            placeholder="Booru import"
            data-test="new-pool-name"
          />
        </label>
      </div>
      <p v-if="poolsError" class="batch-note import-warning">Pools could not be loaded: {{ poolsError }}</p>
      <div class="batch-textarea-label">
        Extra tags
        <TagInput v-model="options.extraTags" placeholder="Added to every imported post..." />
      </div>
    </fieldset>

    <div class="batch-actions-row">
      <button
        type="button"
        class="btn btn-primary"
        data-test="start"
        :disabled="!remotePosts.length"
        @click="startImport"
      >
        {{ startLabel }}
      </button>
      <button
        type="button"
        class="btn btn-danger"
        data-test="cancel"
        :disabled="!running"
        @click="queue.cancel()"
      >
        Cancel
      </button>
      <button
        type="button"
        class="btn btn-secondary"
        data-test="clear"
        :disabled="!finishedCount"
        @click="queue.clearFinished()"
      >
        Clear finished
      </button>
    </div>
    <p v-if="unavailableCount" class="batch-note">
      {{ plural(unavailableCount, 'selected post has', 'selected posts have') }} no original file and will be marked failed.
    </p>

    <div v-if="items.length" class="import-progress" data-test="progress">
      <div class="import-progress-head">
        <strong>{{ progressTitle }}</strong>
        <span>{{ finishedCount }} / {{ items.length }}</span>
      </div>
      <div
        class="import-progress-bar"
        role="progressbar"
        aria-label="Import progress"
        :aria-valuenow="progressPercent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="import-progress-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>
      <div class="import-stats">
        <span>imported {{ progress.done || 0 }}</span>
        <span>merged {{ progress.skipped || 0 }}</span>
        <span :class="{ danger: progress.failed }">failed {{ progress.failed || 0 }}</span>
        <span v-if="cancelledCount">cancelled {{ cancelledCount }}</span>
      </div>
    </div>

    <div v-if="backoffItem" class="import-backoff" role="status" data-test="backoff">
      <strong>{{ backoffTitle }}</strong>
      <span>{{ backoffItem.message }}</span>
    </div>

    <p v-if="poolSummary" class="batch-note" :class="{ 'import-warning': poolResult?.error }" data-test="pool-result">
      {{ poolSummary }}
    </p>

    <ol v-if="items.length" class="import-items" data-test="items">
      <li
        v-for="item in items"
        :key="item.key"
        class="import-item"
        :class="`is-${item.status}`"
        :data-status="item.status"
      >
        <img
          v-if="item.post?.thumbUrl && !brokenThumbs.has(item.key)"
          class="import-thumb"
          :src="item.post.thumbUrl"
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          @error="brokenThumbs.add(item.key)"
        />
        <span v-else class="import-thumb import-thumb-empty" aria-hidden="true"></span>
        <span class="import-item-text">
          <span class="import-item-head">
            <span class="import-item-name">{{ siteLabel(item.post?.site) }} #{{ item.post?.id }}</span>
            <span class="import-pill">{{ statusLabel(item) }}</span>
          </span>
          <span class="import-item-message">
            {{ item.message }}
            <router-link
              v-if="item.postId && FINISHED.has(item.status)"
              class="import-item-link"
              :to="`/post/${item.postId}`"
            >open</router-link>
          </span>
        </span>
      </li>
    </ol>
  </BatchCard>
</template>

<script setup>
import { computed, onMounted, reactive, unref, watch } from 'vue'
import { api } from '../../api/client'
import BatchCard from '../batch/BatchCard.vue'
import TagInput from '../TagInput.vue'
import { NEW_POOL, RETRY_DELAYS_MS } from '../../remote/useImportQueue.js'
import { LIBRARY_SOURCE, siteById } from '../../remote/types.js'

// The batch panel card that imports the selected remote posts into the
// library through the home view's useImportQueue instance (section 4.4 of
// docs/booru-search-plan.md). The queue owns all state; this card only edits
// its options, enqueues the remote selection and renders the items.
const props = defineProps({
  // The object returned by useImportQueue().
  queue: {
    type: Object,
    required: true,
  },
  // The selected RemotePost objects, in selection order. Anything that is not
  // a remote post (a library post, a stray key) is ignored.
  selectedRemote: {
    type: Array,
    default: () => [],
  },
  open: {
    type: Boolean,
    default: true,
  },
})

const emit = defineEmits(['start'])

const FINISHED = new Set(['done', 'skipped', 'failed', 'cancelled'])
const STATUS_LABELS = {
  queued: 'Queued',
  checking: 'Checking',
  resolving: 'Resolving',
  downloading: 'Downloading',
  saving: 'Saving',
  merging: 'Merging',
  retrying: 'Waiting',
  done: 'Imported',
  skipped: 'In library',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const pools = reactive([])
const poolsState = reactive({ error: '' })
const brokenThumbs = reactive(new Set())

const options = computed(() => props.queue.options)
const items = computed(() => props.queue.items || [])
const running = computed(() => Boolean(unref(props.queue.running)))
const progress = computed(() => unref(props.queue.progress) || {})
const poolResult = computed(() => unref(props.queue.poolResult))
const poolsError = computed(() => poolsState.error)

const remotePosts = computed(() => props.selectedRemote.filter((post) => (
  post && typeof post.key === 'string' && post.site !== LIBRARY_SOURCE && siteById(post.site)
)))
const unavailableCount = computed(() => remotePosts.value.filter((post) => !post.fileUrl).length)
const finishedCount = computed(() => items.value.filter((item) => FINISHED.has(item.status)).length)
const cancelledCount = computed(() => items.value.filter((item) => item.status === 'cancelled').length)
const progressPercent = computed(() => (items.value.length
  ? Math.round((finishedCount.value / items.value.length) * 100)
  : 0))

const description = computed(() => {
  const count = remotePosts.value.length
  return count
    ? `${plural(count, 'remote post', 'remote posts')} selected. Downloads one at a time, merging posts already in the library.`
    : 'Select posts from a booru source to import them.'
})

const startLabel = computed(() => {
  const count = plural(remotePosts.value.length, 'post', 'posts')
  return running.value ? `Add ${count} to queue` : `Import ${count}`
})

const progressTitle = computed(() => {
  if (running.value) return 'Importing…'
  if (cancelledCount.value) return 'Import stopped'
  return 'Import finished'
})

// The item the queue is waiting on: a site asked to slow down (attempt > 0)
// or the same file is already downloading elsewhere.
const backoffItem = computed(() => items.value.find((item) => item.status === 'retrying') || null)
const backoffTitle = computed(() => {
  const attempt = Number(backoffItem.value?.attempt) || 0
  return attempt > 0
    ? `Rate limited · attempt ${attempt} of ${RETRY_DELAYS_MS.length}`
    : 'Waiting to retry'
})

const poolSummary = computed(() => {
  const result = poolResult.value
  if (!result) return ''
  if (result.error) return `Adding to the pool failed: ${result.error}`
  const name = pools.find((pool) => pool.id === result.poolId)?.name
  const target = name ? `"${name}"` : `pool #${result.poolId}`
  return `Added ${plural(result.added, 'post', 'posts')} to ${target}.`
})

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

function siteLabel(site) {
  return siteById(site)?.label || site || 'Unknown'
}

function statusLabel(item) {
  if (item.status === 'done' && item.duplicate) return 'Merged'
  return STATUS_LABELS[item.status] || item.status
}

async function loadPools() {
  try {
    const data = await api.getPools({ limit: 100 })
    pools.splice(0, pools.length, ...(Array.isArray(data?.results) ? data.results : []))
    poolsState.error = ''
  } catch (error) {
    poolsState.error = error?.message || String(error)
  }
}

function startImport() {
  const posts = remotePosts.value
  if (!posts.length) return
  const added = props.queue.enqueue(posts) || []
  emit('start', { posts, added })
  props.queue.start()
}

onMounted(loadPools)

// A run that created a new pool: list it, and select it for the next run
// instead of creating a second pool with the same name.
watch(poolResult, async (result) => {
  if (!result?.poolId || result.error || pools.some((pool) => pool.id === result.poolId)) return
  await loadPools()
  if (options.value.poolId === NEW_POOL && pools.some((pool) => pool.id === result.poolId)) {
    options.value.poolId = result.poolId
    options.value.newPoolName = ''
  }
})
</script>

<style scoped>
.import-options {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.import-options:disabled {
  opacity: 0.6;
}

.import-warning {
  color: color-mix(in srgb, var(--coral) 80%, var(--text-primary));
}

.import-progress,
.import-backoff,
.import-items {
  margin-top: 0.85rem;
}

.import-progress-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.import-progress-head strong {
  color: var(--text-primary);
  font-weight: 600;
}

.import-progress-bar {
  height: 6px;
  margin-top: 0.45rem;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-tertiary);
}

.import-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.25s ease;
}

.import-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-variant-numeric: tabular-nums;
}

.import-stats span {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--bg-tertiary);
}

.import-stats .danger {
  color: color-mix(in srgb, var(--coral) 80%, var(--text-primary));
}

.import-backoff {
  display: grid;
  gap: 0.15rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border));
  border-left: 3px solid var(--warning);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--warning) 8%, var(--bg-card));
  font-size: 0.8rem;
}

.import-backoff strong {
  color: var(--text-primary);
  font-weight: 600;
}

.import-backoff span {
  color: var(--text-secondary);
}

.import-items {
  display: grid;
  gap: 0.35rem;
  max-height: 300px;
  margin-bottom: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.import-item {
  --item-color: var(--text-muted);
  display: flex;
  gap: 0.6rem;
  align-items: center;
  min-width: 0;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border);
  border-left: 3px solid var(--item-color);
  border-radius: 0.45rem;
  background: var(--bg-secondary);
}

.import-item.is-checking,
.import-item.is-resolving,
.import-item.is-downloading,
.import-item.is-saving,
.import-item.is-merging {
  --item-color: var(--accent);
}

.import-item.is-retrying {
  --item-color: var(--warning);
}

.import-item.is-done,
.import-item.is-skipped {
  --item-color: var(--success);
}

.import-item.is-failed {
  --item-color: var(--coral);
}

.import-thumb {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 0.35rem;
  background: var(--bg-tertiary);
  object-fit: cover;
}

.import-item-text {
  display: grid;
  flex: 1 1 auto;
  gap: 0.1rem;
  min-width: 0;
}

.import-item-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  align-items: center;
  min-width: 0;
}

.import-item-name {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.82rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-pill {
  flex: 0 0 auto;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--item-color) 16%, transparent);
  color: color-mix(in srgb, var(--item-color) 75%, var(--text-primary));
  font-size: 0.7rem;
  font-weight: 600;
}

.import-item-message {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-item.is-failed .import-item-message {
  color: color-mix(in srgb, var(--coral) 80%, var(--text-primary));
  white-space: normal;
}

.import-item-link {
  margin-left: 0.35rem;
  color: var(--accent);
  font-weight: 600;
}
</style>

<style scoped src="../batch/batchForms.css"></style>
