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
        class="batch-cancel"
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
  --status-color: var(--accent);
  padding: 0.75rem 0.85rem;
  border: 1px solid color-mix(in srgb, var(--status-color) 45%, var(--border));
  border-left: 3px solid var(--status-color);
  border-radius: 0.6rem;
  background: var(--bg-card);
}

.batch-status.success {
  --status-color: var(--success);
}

.batch-status.error {
  --status-color: var(--coral);
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
  gap: 0.15rem;
  min-width: 0;
}

.batch-status-head strong {
  color: var(--text-primary);
  font-size: 0.88rem;
  font-weight: 600;
}

.batch-status-head span {
  color: var(--text-secondary);
  font-size: 0.8rem;
  line-height: 1.4;
}

.batch-cancel {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 0.75rem;
  border: 1px solid color-mix(in srgb, var(--coral) 55%, transparent);
  border-radius: 0.5rem;
  background: transparent;
  color: color-mix(in srgb, var(--coral) 80%, var(--text-primary));
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.batch-cancel:hover:not(:disabled) {
  border-color: var(--coral);
  background: var(--coral);
  color: #fff;
}

.batch-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.batch-progress {
  height: 6px;
  margin-top: 0.65rem;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-tertiary);
}

.batch-progress-fill {
  height: 100%;
  min-width: 4px;
  border-radius: inherit;
  background: var(--status-color);
  transition: width 0.25s ease;
}

.batch-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.55rem;
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-variant-numeric: tabular-nums;
}

.batch-stats span {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--bg-tertiary);
}

.batch-stats .danger,
.batch-error {
  color: color-mix(in srgb, var(--coral) 80%, var(--text-primary));
}

.batch-error {
  margin: 0.55rem 0 0;
  font-size: 0.8rem;
}
</style>
