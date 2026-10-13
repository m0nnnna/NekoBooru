<template>
  <div v-if="visible" class="batch-status" :class="kind">
    <div class="batch-status-head">
      <div>
        <strong>{{ title }}</strong>
        <span>{{ detail }}</span>
      </div>
      <button
        v-if="canCancel"
        type="button"
        class="btn btn-danger"
        :disabled="autoJob?.status === 'cancelling'"
        @click="$emit('cancel')"
      >
        {{ autoJob?.status === 'cancelling' ? 'Cancelling...' : 'Cancel Job' }}
      </button>
    </div>
    <div class="batch-progress">
      <div class="batch-progress-fill" :style="{ width: progressPercent + '%' }"></div>
    </div>
    <div class="batch-stats">
      <span>{{ progressPercent }}%</span>
      <span v-if="autoJob">processed {{ autoJob.processed }} / {{ autoJob.total }}</span>
      <span v-if="autoJob">tagged {{ autoJob.tagged }}</span>
      <span v-if="autoJob">skipped {{ autoJob.skipped }}</span>
      <span v-if="autoJob" :class="{ danger: autoJob.failed }">failed {{ autoJob.failed }}</span>
      <span v-if="!autoJob && operationTotal">selected {{ operationTotal }}</span>
    </div>
    <p v-if="autoJob?.error" class="batch-error">{{ autoJob.error }}</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { isAutoJobRunning } from '../../composables/useBatchOperations'

// Progress for the batch action currently running on the selection: either a
// polled backend AI auto-tag job or a local batch operation.
const props = defineProps({
  autoJob: {
    type: Object,
    default: null,
  },
  operation: {
    type: Object,
    default: null,
  },
})

defineEmits(['cancel'])

const autoJobRunning = computed(() => isAutoJobRunning(props.autoJob))
const canCancel = computed(() => Boolean(autoJobRunning.value && props.autoJob?.id))
const visible = computed(() => Boolean(props.autoJob || props.operation))
const operationTotal = computed(() => props.operation?.total || 0)

const progressPercent = computed(() => {
  if (props.autoJob) {
    const total = Number(props.autoJob.total || 0)
    if (!total) return autoJobRunning.value ? 5 : 100
    return Math.max(0, Math.min(100, Math.round((Number(props.autoJob.processed || 0) / total) * 100)))
  }
  if (!props.operation) return 0
  return props.operation.status === 'completed' ? 100 : props.operation.progress
})

const kind = computed(() => {
  if (props.autoJob?.status === 'failed' || props.operation?.status === 'failed') return 'error'
  if (props.autoJob && ['completed', 'cancelled'].includes(props.autoJob.status)) return 'success'
  if (props.operation?.status === 'completed') return 'success'
  return 'running'
})

const title = computed(() => {
  if (props.autoJob) {
    const type = props.autoJob.dryRun ? 'AI Preview Job' : 'AI Run & Apply Job'
    return `${type} #${props.autoJob.id} ${props.autoJob.status}`
  }
  return props.operation?.title || 'Batch operation'
})

const detail = computed(() => {
  const job = props.autoJob
  if (job) {
    if (job.status === 'queued') return 'Waiting for the backend worker to start.'
    if (job.status === 'running') return 'Analyzing selected posts. Large models can take a while per item.'
    if (job.status === 'cancelling') return 'Cancel requested. The current model call may finish first.'
    if (job.status === 'completed') return job.dryRun
      ? 'Preview suggestions are ready in Settings.'
      : 'Tags and safety updates have been applied.'
    if (job.status === 'cancelled') return 'Job was cancelled.'
    if (job.status === 'failed') return 'Job failed. Check the error below.'
  }
  return props.operation?.detail || ''
})
</script>

<style scoped>
.batch-status {
  margin-top: 0.85rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: var(--bg-tertiary);
}

.batch-status.running {
  border-color: rgba(96, 165, 250, 0.55);
}

.batch-status.success {
  border-color: rgba(74, 222, 128, 0.55);
}

.batch-status.error {
  border-color: rgba(248, 113, 113, 0.65);
}

.batch-status-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
}

.batch-status-head > div {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.batch-status-head strong {
  color: var(--text-primary);
}

.batch-status-head span,
.batch-stats {
  color: var(--text-secondary);
}

.batch-progress {
  height: 9px;
  margin-top: 0.75rem;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.batch-progress-fill {
  height: 100%;
  min-width: 4px;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.25s ease;
}

.batch-status.success .batch-progress-fill {
  background: var(--success, #22c55e);
}

.batch-status.error .batch-progress-fill {
  background: var(--coral, #f87171);
}

.batch-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.65rem;
  font-size: 0.85rem;
}

.batch-stats span {
  padding: 0.2rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.12);
}

.batch-stats .danger,
.batch-error {
  color: var(--coral, #f87171);
}

.batch-error {
  margin: 0.65rem 0 0;
}
</style>
