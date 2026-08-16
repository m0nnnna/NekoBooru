<template>
  <div v-if="job" class="job-progress" :class="[job.status, { compact }]">
    <div class="progress-summary">
      <strong>{{ job.message }}</strong>
      <span>{{ job.overallProgress }}%</span>
    </div>
    <div
      class="overall-track"
      role="progressbar"
      aria-label="Overall operation progress"
      :aria-valuenow="job.overallProgress"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div class="overall-fill" :style="{ width: `${job.overallProgress}%` }"></div>
    </div>
    <div class="stage-list">
      <div v-for="stage in job.stages || []" :key="stage.id" class="stage" :class="stage.state">
        <span class="stage-dot"></span>
        <div class="stage-label">
          <strong>{{ stage.label }}</strong>
          <small>{{ stage.detail || stage.state }}</small>
        </div>
        <div
          class="stage-track"
          role="progressbar"
          :aria-label="stage.label"
          :aria-valuenow="stage.progress"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div :style="{ width: `${stage.progress}%` }"></div>
        </div>
      </div>
    </div>
    <div v-if="metricsText" class="metrics">{{ metricsText }}</div>
    <div v-if="job.error" class="job-error">
      <strong>{{ job.error.message }}</strong>
      <span v-if="job.error.remediation">{{ job.error.remediation }}</span>
      <router-link v-if="['ytdlp_missing', 'media_tools_missing'].includes(job.error.code)" to="/settings">Open Settings</router-link>
    </div>
    <div v-if="actions" class="job-actions">
      <button v-if="job.canCancel" class="btn btn-secondary btn-sm" type="button" @click="$emit('cancel')">Cancel</button>
      <button v-if="job.canRetry" class="btn btn-secondary btn-sm" type="button" @click="$emit('retry')">Retry</button>
      <button v-if="!job.canCancel && !job.resultPostId" class="btn btn-secondary btn-sm" type="button" @click="$emit('remove')">Remove job</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  job: { type: Object, required: true },
  compact: { type: Boolean, default: false },
  actions: { type: Boolean, default: false },
})
defineEmits(['cancel', 'retry', 'remove'])

const metricsText = computed(() => {
  const metrics = props.job?.metrics || {}
  if (metrics.downloadedBytes) {
    const total = metrics.totalBytes ? ` / ${formatBytes(metrics.totalBytes)}` : ''
    const speed = metrics.speedBytesPerSec ? ` · ${formatBytes(metrics.speedBytesPerSec)}/s` : ''
    const eta = metrics.etaSeconds != null ? ` · ${Math.round(metrics.etaSeconds)}s remaining` : ''
    return `${formatBytes(metrics.downloadedBytes)}${total}${speed}${eta}`
  }
  if (metrics.processedMs != null) {
    return `${formatDuration(metrics.processedMs)} / ${formatDuration(metrics.totalMs)} processed`
  }
  if (metrics.attachmentCount != null) return `${metrics.attachmentCount} attachment(s)`
  return ''
})

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let amount = bytes / 1024
  let index = 0
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++ }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0) / 1000
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
}
</script>

<style scoped>
.job-progress { padding: 1rem; border: 1px solid var(--border); border-radius: .65rem; background: var(--bg-secondary); }
.job-progress.compact { margin-top: .65rem; padding: .7rem; }
.progress-summary, .job-actions { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
.overall-track, .stage-track { height: 9px; overflow: hidden; background: var(--bg-tertiary); border-radius: 999px; }
.overall-fill, .stage-track div { height: 100%; background: var(--accent); transition: width .2s ease; }
.stage-list { display: grid; gap: .45rem; margin-top: .75rem; }
.stage { display: grid; grid-template-columns: 12px minmax(140px, 1fr) minmax(100px, 2fr); align-items: center; gap: .6rem; }
.stage-label { display: grid; }
.stage small { color: var(--text-muted); text-transform: capitalize; }
.stage-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--text-muted); }
.stage.running .stage-dot { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.stage.running .stage-track div { animation: progress-pulse 1.2s ease-in-out infinite; }
.stage.completed .stage-dot { background: var(--success); }
.metrics { margin-top: .5rem; color: var(--text-secondary); font-size: .84rem; }
.job-error { display: grid; padding: .75rem; margin-top: .75rem; border-radius: .5rem; background: var(--coral-soft); color: var(--coral); }
.job-error a { color: inherit; font-weight: 700; }
.job-actions { justify-content: flex-end; margin-top: .75rem; }
@keyframes progress-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@media (max-width: 800px) {
  .stage { grid-template-columns: 12px 1fr; }
  .stage-track { grid-column: 2; }
}
</style>
