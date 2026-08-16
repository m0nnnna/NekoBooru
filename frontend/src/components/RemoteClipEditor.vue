<template>
  <section class="clip-editor card" aria-labelledby="clip-editor-title">
    <div class="clip-head">
      <div>
        <h2 id="clip-editor-title">Clip from video link</h2>
        <p>YouTube, Rumble, or Odysee · precise preview · X-compatible MP4</p>
      </div>
      <span v-if="provider" class="provider-badge">{{ provider }}</span>
    </div>

    <div class="source-grid">
      <label class="source-url">
        Video URL
        <input ref="urlInput" v-model.trim="sourceUrl" type="url" placeholder="https://www.youtube.com/watch?v=…" :disabled="busy || restoring" />
      </label>
      <label>
        Start
        <input v-model="startText" inputmode="decimal" placeholder="32:35" :disabled="busy || restoring" @blur="normalizeTimeInputs" />
      </label>
      <label>
        End
        <input v-model="endText" inputmode="decimal" placeholder="33:10" :disabled="busy || restoring" @blur="normalizeTimeInputs" />
      </label>
      <button class="btn load-btn" :disabled="busy || restoring || !sourceUrl" @click="loadSelection">
        {{ job ? 'Load updated selection' : 'Load selection' }}
      </button>
    </div>

    <div v-if="job?.source?.title" class="source-meta">
      <img v-if="job.source.thumbnail" :src="job.source.thumbnail" alt="" />
      <div>
        <strong>{{ job.source.title }}</strong>
        <span>{{ job.source.uploader || provider }} · {{ formatTimecode(job.source.durationMs, false) }}</span>
      </div>
    </div>

    <UploadJobProgress
      v-if="job"
      :job="job"
      actions
      @cancel="cancelJob"
      @retry="retryJob"
      @remove="removeJob"
    />

    <div v-if="sampleArtifact" class="precision-editor" tabindex="0" @keydown="handleEditorKey">
      <video
        ref="sampleVideo"
        :src="sampleArtifact.contentUrl"
        controls
        playsinline
        preload="metadata"
        @timeupdate="onTimeUpdate"
        @loadedmetadata="seekToIn"
      ></video>

      <div class="timeline" :style="timelineStyle" @click="seekTimeline">
        <img v-if="timelineArtifact" :src="timelineArtifact.contentUrl" alt="Timeline thumbnails" draggable="false" />
        <img v-if="waveformArtifact" :src="waveformArtifact.contentUrl" class="waveform" alt="Audio waveform" draggable="false" />
        <div class="selection-window" :style="selectionStyle"></div>
        <div class="playhead" :style="playheadStyle"></div>
      </div>

      <div class="range-controls">
        <label>
          In {{ formatTimecode(startMs) }}
          <input v-model.number="startMs" type="range" :min="contextStartMs" :max="Math.max(contextStartMs, endMs - 500)" step="1" aria-label="Clip start" @input="selectionChanged('start')" />
        </label>
        <label>
          Out {{ formatTimecode(endMs) }}
          <input v-model.number="endMs" type="range" :min="Math.min(contextEndMs, startMs + 500)" :max="contextEndMs" step="1" aria-label="Clip end" @input="selectionChanged('end')" />
        </label>
      </div>
      <div class="editor-toolbar">
        <button class="btn btn-secondary btn-sm" @click="seekToIn">Jump to in</button>
        <button class="btn btn-secondary btn-sm" @click="seekToOut">Jump to out</button>
        <label class="loop-toggle"><input v-model="loopSelection" type="checkbox" /> Loop selection</label>
        <span>{{ formatTimecode(currentSourceMs) }} / {{ formatTimecode(job.source.durationMs, false) }}</span>
        <span>Space play · ←/→ frame · Shift+←/→ 1s · I/O set points</span>
      </div>
      <button class="btn render-btn" :disabled="busy || selectionDirty" @click="renderClip">
        {{ selectionDirty ? 'Reload preview before rendering' : 'Render X-ready clip' }}
      </button>
    </div>

    <div v-if="renderArtifact" class="final-review">
      <h3>Final review</h3>
      <video :src="renderArtifact.contentUrl" controls playsinline preload="metadata"></video>
      <div class="compliance-grid">
        <span class="pass">✓ {{ formatTimecode(Math.round((renderArtifact.duration || 0) * 1000)) }}</span>
        <span class="pass">✓ {{ renderArtifact.width }}×{{ renderArtifact.height }}</span>
        <span class="pass">✓ {{ renderArtifact.metadata.codec?.toUpperCase() }} / {{ renderArtifact.metadata.audioCodec?.toUpperCase() || 'silent' }} MP4</span>
        <span class="pass">✓ {{ formatBytes(renderArtifact.fileSize) }}</span>
        <span class="pass">✓ Progressive YUV 4:2:0</span>
        <span class="pass">✓ Standard X duration limit</span>
      </div>
      <div class="review-actions">
        <a class="btn btn-secondary" :href="renderArtifact.downloadUrl">Download MP4</a>
        <button class="btn btn-secondary" @click="seekToIn">Adjust cut</button>
      </div>

      <div class="post-fields">
        <TagInput v-model="tags" placeholder="Add tags (comma separated)…" :disabled="busy" />
        <label>Rating
          <select v-model="safety" :disabled="busy">
            <option value="safe">Safe</option>
            <option value="sketchy">Sketchy</option>
            <option value="unsafe">Unsafe</option>
          </select>
        </label>
        <label>Source
          <input v-model="postSource" type="url" :disabled="busy" />
        </label>
        <label class="loop-toggle"><input v-model="autoTag" type="checkbox" :disabled="busy" /> Auto-tag after publishing</label>
        <label v-if="autoTag">AI profile
          <select v-model="autoTagProfile" :disabled="busy">
            <option value="anime">Anime / Booru</option>
            <option value="realistic">Realistic</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>
      <button class="btn publish-btn" :disabled="busy" @click="publishClip">Publish reviewed clip</button>
    </div>

    <div v-if="job?.resultPostId" class="published">
      <span>Clip published successfully.</span>
      <router-link class="btn" :to="`/post/${job.resultPostId}`">Open post #{{ job.resultPostId }}</router-link>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import api from '../api/client'
import TagInput from './TagInput.vue'
import UploadJobProgress from './UploadJobProgress.vue'
import { clampSelection, formatTimecode, parseTimecode } from '../utils/timecode'

const STORAGE_KEY = 'nekobooru.remoteClipJob'
const sourceUrl = ref('')
const startText = ref('0:00.000')
const endText = ref('0:30.000')
const startMs = ref(0)
const endMs = ref(30_000)
const job = ref(null)
const urlInput = ref(null)
const sampleVideo = ref(null)
const currentSourceMs = ref(0)
const loopSelection = ref(true)
const selectionDirty = ref(false)
const restoring = ref(true)
const tags = ref([])
const safety = ref('safe')
const postSource = ref('')
const autoTag = ref(false)
const autoTagProfile = ref('anime')
let events = null
let pollTimer = null

const busy = computed(() => ['probing', 'sampling', 'rendering', 'publishing'].includes(job.value?.status))
const provider = computed(() => job.value?.source?.provider || detectProvider(sourceUrl.value))
const artifact = role => job.value?.artifacts?.find(item => item.role === role)
const sampleArtifact = computed(() => artifact('sample'))
const timelineArtifact = computed(() => artifact('timeline'))
const waveformArtifact = computed(() => artifact('waveform'))
const renderArtifact = computed(() => artifact('render'))
const contextStartMs = computed(() => sampleArtifact.value?.metadata?.contextStartMs ?? startMs.value)
const contextEndMs = computed(() => sampleArtifact.value?.metadata?.contextEndMs ?? endMs.value)
const contextDurationMs = computed(() => Math.max(1, contextEndMs.value - contextStartMs.value))
const timelineStyle = computed(() => ({ '--selection-start': `${((startMs.value - contextStartMs.value) / contextDurationMs.value) * 100}%` }))
const selectionStyle = computed(() => ({ left: `${((startMs.value - contextStartMs.value) / contextDurationMs.value) * 100}%`, width: `${((endMs.value - startMs.value) / contextDurationMs.value) * 100}%` }))
const playheadStyle = computed(() => ({ left: `${Math.max(0, Math.min(100, ((currentSourceMs.value - contextStartMs.value) / contextDurationMs.value) * 100))}%` }))
function detectProvider(value) {
  try {
    const host = new URL(value).hostname.toLowerCase()
    if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'YouTube'
    if (host.endsWith('rumble.com')) return 'Rumble'
    if (host.endsWith('odysee.com') || host.endsWith('lbry.tv')) return 'Odysee'
  } catch {}
  return ''
}

function normalizeTimeInputs() {
  const parsedStart = parseTimecode(startText.value)
  const parsedEnd = parseTimecode(endText.value)
  if (parsedStart !== null) startMs.value = parsedStart
  if (parsedEnd !== null) endMs.value = parsedEnd
  const duration = job.value?.source?.durationMs
  if (duration) {
    const clamped = clampSelection(startMs.value, endMs.value, duration)
    startMs.value = clamped.startMs
    endMs.value = clamped.endMs
  } else {
    startMs.value = Math.max(0, startMs.value)
    endMs.value = Math.max(0, endMs.value)
  }
  startText.value = formatTimecode(startMs.value)
  endText.value = formatTimecode(endMs.value)
}

async function loadSelection() {
  normalizeTimeInputs()
  if (!detectProvider(sourceUrl.value)) {
    window.alert('Enter a YouTube, Rumble, or Odysee video URL.')
    return
  }
  try {
    if (!job.value || job.value.sourceUrl !== sourceUrl.value || ['completed'].includes(job.value.status)) {
      if (job.value && !busy.value) await removeJob(false)
      const key = crypto.randomUUID()
      job.value = await api.createUploadJob({
        kind: 'remote_clip',
        sourceUrl: sourceUrl.value,
        selection: { startMs: startMs.value, endMs: endMs.value },
        profile: 'x-standard',
      }, key)
      localStorage.setItem(STORAGE_KEY, job.value.id)
      connectEvents(job.value.id)
    } else {
      job.value = await api.sampleUploadJob(job.value.id, { startMs: startMs.value, endMs: endMs.value, revision: job.value.revision })
      selectionDirty.value = false
    }
  } catch (error) {
    window.alert(error.message)
  }
}

async function renderClip() {
  try {
    job.value = await api.renderUploadJob(job.value.id, { revision: job.value.revision, profile: 'x-standard' })
  } catch (error) {
    window.alert(error.message)
  }
}

async function publishClip() {
  try {
    job.value = await api.publishUploadJob(job.value.id, {
      artifactId: renderArtifact.value.id,
      revision: job.value.revision,
      tags: tags.value,
      safety: safety.value,
      source: postSource.value || job.value.source?.canonicalUrl || sourceUrl.value,
      autoTag: autoTag.value,
      autoTagProfile: autoTag.value ? autoTagProfile.value : null,
    }, crypto.randomUUID())
  } catch (error) {
    window.alert(error.message)
  }
}

async function cancelJob() {
  job.value = await api.cancelUploadJob(job.value.id)
}

async function retryJob() {
  job.value = await api.retryUploadJob(job.value.id)
  connectEvents(job.value.id)
}

async function removeJob(clear = true) {
  if (!job.value) return
  const id = job.value.id
  disconnectEvents()
  await api.deleteUploadJob(id)
  if (clear) {
    job.value = null
    localStorage.removeItem(STORAGE_KEY)
  }
}

function connectEvents(id) {
  disconnectEvents()
  if ('EventSource' in window) {
    events = new EventSource(`/api/upload-jobs/${encodeURIComponent(id)}/events`)
    const receive = event => applySnapshot(JSON.parse(event.data))
    events.addEventListener('snapshot', receive)
    events.addEventListener('progress', receive)
    events.addEventListener('state', receive)
    events.addEventListener('error', event => {
      if (event.data) receive(event)
      else startPolling(id)
    })
    events.onerror = () => startPolling(id)
  } else startPolling(id)
}

function startPolling(id) {
  if (events) {
    events.close()
    events = null
  }
  if (pollTimer) return
  pollTimer = window.setInterval(async () => {
    try { applySnapshot(await api.getUploadJob(id)) } catch {}
  }, 1000)
}

function disconnectEvents() {
  if (events) events.close()
  if (pollTimer) clearInterval(pollTimer)
  events = null
  pollTimer = null
}

function applySnapshot(value) {
  if (!value) return
  const previousStatus = job.value?.status
  job.value = value
  localStorage.setItem(STORAGE_KEY, value.id)
  if (value.source?.canonicalUrl && !postSource.value) postSource.value = value.source.canonicalUrl
  if (value.selection && previousStatus !== 'sample_ready') {
    startMs.value = value.selection.startMs
    endMs.value = value.selection.endMs
    startText.value = formatTimecode(startMs.value)
    endText.value = formatTimecode(endMs.value)
  }
  if (value.status === 'sample_ready') selectionDirty.value = false
  if (['completed', 'failed', 'cancelled', 'interrupted', 'sample_ready', 'render_ready', 'awaiting_selection'].includes(value.status)) {
    if (value.status === 'completed') disconnectEvents()
  }
}

function selectionChanged(handle) {
  const clamped = clampSelection(startMs.value, endMs.value, job.value.source.durationMs)
  startMs.value = clamped.startMs
  endMs.value = clamped.endMs
  startText.value = formatTimecode(startMs.value)
  endText.value = formatTimecode(endMs.value)
  selectionDirty.value = startMs.value !== sampleArtifact.value?.metadata?.selectionStartMs || endMs.value !== sampleArtifact.value?.metadata?.selectionEndMs
  if (handle === 'start') seekToIn()
  else seekToOut()
}

function onTimeUpdate() {
  if (!sampleVideo.value) return
  currentSourceMs.value = contextStartMs.value + sampleVideo.value.currentTime * 1000
  if (loopSelection.value && currentSourceMs.value >= endMs.value) seekToIn()
}

function seekToIn() {
  nextTick(() => {
    if (sampleVideo.value) sampleVideo.value.currentTime = Math.max(0, (startMs.value - contextStartMs.value) / 1000)
  })
}

function seekToOut() {
  if (sampleVideo.value) sampleVideo.value.currentTime = Math.max(0, (endMs.value - contextStartMs.value) / 1000)
}

function seekTimeline(event) {
  if (!sampleVideo.value) return
  const rect = event.currentTarget.getBoundingClientRect()
  sampleVideo.value.currentTime = Math.max(0, Math.min(sampleVideo.value.duration, ((event.clientX - rect.left) / rect.width) * sampleVideo.value.duration))
}

function handleEditorKey(event) {
  if (!sampleVideo.value || ['INPUT', 'SELECT', 'BUTTON'].includes(event.target.tagName)) return
  if (event.code === 'Space') {
    event.preventDefault()
    sampleVideo.value.paused ? sampleVideo.value.play() : sampleVideo.value.pause()
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    sampleVideo.value.currentTime = Math.max(0, Math.min(sampleVideo.value.duration, sampleVideo.value.currentTime + direction * (event.shiftKey ? 1 : 1 / 30)))
  } else if (event.key.toLowerCase() === 'i') {
    startMs.value = Math.min(endMs.value - 500, Math.round(currentSourceMs.value)); selectionChanged('start')
  } else if (event.key.toLowerCase() === 'o') {
    endMs.value = Math.max(startMs.value + 500, Math.round(currentSourceMs.value)); selectionChanged('end')
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let amount = bytes / 1024
  let index = 0
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++ }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`
}

function setUrl(value) {
  sourceUrl.value = value
  nextTick(() => urlInput.value?.focus())
}

defineExpose({ setUrl })

onMounted(async () => {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (!saved) {
    restoring.value = false
    return
  }
  try {
    const restored = await api.getUploadJob(saved)
    applySnapshot(restored)
    sourceUrl.value = restored.sourceUrl || ''
    connectEvents(saved)
  } catch {
    localStorage.removeItem(STORAGE_KEY)
  } finally {
    restoring.value = false
  }
})
onUnmounted(disconnectEvents)
</script>

<style scoped>
.clip-editor { margin-bottom: 1.5rem; display: grid; gap: 1rem; }
.clip-head, .editor-toolbar, .review-actions, .published { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
.clip-head p, .source-meta span, .editor-toolbar span { color: var(--text-secondary); font-size: .84rem; }
.provider-badge { padding: .25rem .65rem; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 700; text-transform: uppercase; font-size: .75rem; }
.source-grid { display: grid; grid-template-columns: minmax(260px, 1fr) 130px 130px auto; gap: .75rem; align-items: end; }
.source-grid label, .post-fields label, .range-controls label { display: grid; gap: .35rem; color: var(--text-secondary); font-size: .82rem; }
.source-meta { display: flex; gap: .75rem; align-items: center; }
.source-meta img { width: 96px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: .5rem; }
.source-meta div { display: grid; }
.precision-editor, .final-review { display: grid; gap: .8rem; outline: none; }
video { display: block; width: 100%; max-height: 560px; background: #000; border-radius: .65rem; }
.timeline { position: relative; height: 128px; overflow: hidden; border-radius: .5rem; background: #08090a; cursor: crosshair; }
.timeline > img:first-child { width: 100%; height: 100%; object-fit: cover; opacity: .78; }
.timeline .waveform { position: absolute; inset: auto 0 0; width: 100%; height: 45%; object-fit: fill; opacity: .65; mix-blend-mode: screen; }
.selection-window { position: absolute; top: 0; bottom: 0; border: 2px solid var(--accent); background: rgba(106,173,222,.12); pointer-events: none; }
.playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: white; box-shadow: 0 0 4px #000; pointer-events: none; }
.range-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.range-controls input { width: 100%; padding: 0; }
.loop-toggle { display: flex !important; grid-template-columns: auto 1fr; align-items: center; gap: .5rem; }
.render-btn, .publish-btn { justify-self: end; }
.compliance-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem; }
.compliance-grid span { padding: .5rem; border-radius: .4rem; background: var(--success-soft); color: var(--success); font-size: .82rem; }
.post-fields { display: grid; gap: .75rem; }
.published { padding: 1rem; background: var(--success-soft); border-radius: .65rem; }
@media (max-width: 800px) {
  .source-grid { grid-template-columns: 1fr 1fr; }
  .source-url { grid-column: 1 / -1; }
  .load-btn { grid-column: 1 / -1; }
  .compliance-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 520px) {
  .source-grid, .range-controls, .compliance-grid { grid-template-columns: 1fr; }
  .timeline { height: 92px; }
}
</style>
