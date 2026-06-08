<template>
  <div class="stats-view">
    <h1>Library Statistics</h1>

    <div v-if="loading" class="loading">Loading...</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Totals -->
      <div class="card-grid">
        <div class="stat-card"><div class="stat-num">{{ data.totals.posts }}</div><div class="stat-label">Posts</div></div>
        <div class="stat-card"><div class="stat-num">{{ data.totals.tags }}</div><div class="stat-label">Tags</div></div>
        <div class="stat-card"><div class="stat-num">{{ data.totals.pools }}</div><div class="stat-label">Pools</div></div>
        <div class="stat-card"><div class="stat-num">{{ data.totals.favorites }}</div><div class="stat-label">Favorites</div></div>
        <div class="stat-card"><div class="stat-num">{{ data.totals.comments }}</div><div class="stat-label">Comments</div></div>
        <div class="stat-card"><div class="stat-num">{{ data.untagged }}</div><div class="stat-label">Untagged</div></div>
      </div>

      <div class="two-col">
        <section class="panel">
          <h2>Media types</h2>
          <BreakdownBar :items="typeItems" />
        </section>
        <section class="panel">
          <h2>Safety</h2>
          <BreakdownBar :items="safetyItems" />
        </section>
      </div>

      <section class="panel">
        <h2>Storage</h2>
        <dl class="kv">
          <dt>Total media</dt><dd>{{ data.totalSizeFormatted }}</dd>
          <dt>Average post</dt><dd>{{ data.avgSizeFormatted }}</dd>
          <dt>Database</dt><dd>{{ data.databaseSizeFormatted }}</dd>
          <dt>Oldest post</dt><dd>{{ fmtDate(data.oldestPost) }}</dd>
          <dt>Newest post</dt><dd>{{ fmtDate(data.newestPost) }}</dd>
        </dl>
      </section>

      <section class="panel" v-if="data.uploadsByMonth.length">
        <h2>Uploads over time</h2>
        <div class="chart">
          <div
            v-for="m in recentMonths"
            :key="m.month"
            class="chart-bar"
            :title="`${m.month}: ${m.count}`"
          >
            <div class="chart-fill" :style="{ height: barHeight(m.count) }"></div>
            <span class="chart-x">{{ m.month.slice(2) }}</span>
          </div>
        </div>
      </section>

      <div class="two-col">
        <section class="panel">
          <h2>Top tags</h2>
          <ul class="tag-list">
            <li v-for="t in data.topTags" :key="t.name">
              <router-link :to="`/?q=${encodeURIComponent(t.name)}`" class="tag-name">
                <span class="dot" :style="{ background: t.color }"></span>{{ t.name }}
              </router-link>
              <span class="tag-count">{{ t.count }}</span>
            </li>
          </ul>
        </section>
        <section class="panel">
          <h2>Tags by category</h2>
          <BreakdownBar :items="categoryItems" />
        </section>
      </div>

      <!-- Duplicates / similarity -->
      <section class="panel">
        <h2>Near-duplicates</h2>
        <p class="muted">
          {{ data.duplicateGroups }} group(s) of posts share an identical perceptual hash.
          <span v-if="data.phashMissing > 0">
            {{ data.phashMissing }} post(s) have not been hashed yet.
          </span>
        </p>
        <div class="dup-actions">
          <button v-if="data.phashMissing > 0" class="btn btn-secondary" @click="runBackfill" :disabled="backfillRunning">
            {{ backfillRunning ? `Hashing ${backfillJob?.processed || 0}/${backfillJob?.total || '?'}...` : `Compute missing hashes (${data.phashMissing})` }}
          </button>
          <button class="btn" @click="loadDuplicates" :disabled="dupLoading || data.duplicateGroups === 0">
            {{ dupLoading ? 'Loading...' : 'Show duplicate groups' }}
          </button>
        </div>

        <div v-for="(group, gi) in duplicateGroups" :key="gi" class="dup-group">
          <div class="dup-row">
            <router-link
              v-for="p in group.posts"
              :key="p.id"
              :to="`/post/${p.id}`"
              class="dup-thumb"
              :title="`#${p.id}`"
            >
              <img :src="p.thumbUrl" :alt="p.filename" loading="lazy" />
            </router-link>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import api from '../api/client'
import BreakdownBar from '../components/BreakdownBar.vue'

const data = ref(null)
const loading = ref(true)
const error = ref(null)
const duplicateGroups = ref([])
const dupLoading = ref(false)
const backfillRunning = ref(false)
const backfillJob = ref(null)
let backfillTimer = null

const typeItems = computed(() => data.value ? [
  { label: 'Images', value: data.value.types.images, color: '#0075f8' },
  { label: 'GIFs', value: data.value.types.gifs, color: '#00c853' },
  { label: 'Videos', value: data.value.types.videos, color: '#d500f9' },
] : [])

const safetyItems = computed(() => data.value ? [
  { label: 'Safe', value: data.value.safety.safe, color: '#4ade80' },
  { label: 'Sketchy', value: data.value.safety.sketchy, color: '#facc15' },
  { label: 'Unsafe', value: data.value.safety.unsafe, color: '#f87171' },
] : [])

const categoryItems = computed(() =>
  (data.value?.tagsByCategory || []).map(c => ({ label: c.name, value: c.count, color: c.color })))

const recentMonths = computed(() => (data.value?.uploadsByMonth || []).slice(-12))
const maxMonth = computed(() => Math.max(1, ...recentMonths.value.map(m => m.count)))
function barHeight(count) {
  return `${Math.max(4, Math.round((count / maxMonth.value) * 100))}%`
}

function fmtDate(s) {
  return s ? new Date(s).toLocaleDateString() : '—'
}

onMounted(load)
onUnmounted(() => { if (backfillTimer) clearInterval(backfillTimer) })

async function load() {
  loading.value = true
  try {
    data.value = await api.getDashboard()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadDuplicates() {
  dupLoading.value = true
  try {
    const res = await api.getDuplicateGroups()
    duplicateGroups.value = res.groups || []
  } catch (e) {
    alert('Failed to load duplicates: ' + e.message)
  } finally {
    dupLoading.value = false
  }
}

async function runBackfill() {
  backfillRunning.value = true
  try {
    await api.startSimilarityBackfill()
    backfillTimer = setInterval(async () => {
      const status = await api.getSimilarityBackfill()
      backfillJob.value = status.job
      if (!status.job || status.job.status !== 'running') {
        clearInterval(backfillTimer)
        backfillTimer = null
        backfillRunning.value = false
        await load() // refresh counts
      }
    }, 1000)
  } catch (e) {
    backfillRunning.value = false
    alert('Failed to start hashing: ' + e.message)
  }
}
</script>

<style scoped>
.stats-view {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

h1 {
  margin: 0;
}

h2 {
  font-size: 0.8rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0 0 0.75rem;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 0.75rem;
}

.stat-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 1rem;
  text-align: center;
}

.stat-num {
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-label {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-top: 0.25rem;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 1.25rem;
}

.kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.4rem 1rem;
  margin: 0;
  font-size: 0.9rem;
}

.kv dt { color: var(--text-secondary); }
.kv dd { margin: 0; text-align: right; color: var(--text-primary); }

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  margin-right: 0.4rem;
  vertical-align: middle;
}

.chart {
  display: flex;
  align-items: flex-end;
  gap: 0.4rem;
  height: 140px;
}

.chart-bar {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  min-width: 0;
}

.chart-fill {
  width: 70%;
  background: var(--accent);
  border-radius: 3px 3px 0 0;
  transition: height 0.2s;
}

.chart-x {
  margin-top: 0.35rem;
  font-size: 0.7rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.tag-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.tag-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.9rem;
}

.tag-name {
  color: var(--text-primary);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-name:hover { color: var(--accent); }
.tag-count { color: var(--text-secondary); }

.muted { color: var(--text-secondary); font-size: 0.9rem; }

.dup-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin: 0.75rem 0;
}

.dup-group {
  padding: 0.5rem 0;
  border-top: 1px solid var(--border);
}

.dup-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.dup-thumb {
  display: block;
  width: 84px;
  height: 84px;
  border-radius: 0.4rem;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.dup-thumb img { width: 100%; height: 100%; object-fit: cover; }

.loading, .error {
  text-align: center;
  padding: 3rem;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .two-col { grid-template-columns: 1fr; }
}
</style>
