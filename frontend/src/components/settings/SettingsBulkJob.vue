<template>
  <div class="config-panel">
    <div class="config-panel-head">
      <h3>Bulk Library Job</h3>
      <p>Run auto-tagging across existing posts using the saved defaults above.</p>
    </div>
    <div class="bulk-toolbar">
      <label class="field-row bulk-mode">
        <span>Target posts</span>
        <select v-model="autoTagMode">
          <option value="lightly_tagged">Lightly tagged</option>
          <option value="untagged">Untagged</option>
          <option value="videos">Videos</option>
          <option value="images">Images</option>
          <option value="all">All</option>
        </select>
      </label>
      <div class="bulk-actions">
        <div class="bulk-action-group">
          <span>Setup</span>
          <button class="btn action-tooltip" :data-tooltip="bulkActionHelp.save" @click="saveAutoTagSettings" :disabled="savingAutoTags">
            {{ savingAutoTags ? 'Saving...' : 'Save Settings' }}
          </button>
          <button class="btn btn-secondary action-tooltip" :data-tooltip="bulkActionHelp.estimate" @click="estimateAutoTags">Estimate</button>
        </div>
        <div class="bulk-action-group">
          <span>Review first</span>
          <button class="btn btn-secondary action-tooltip" :data-tooltip="bulkActionHelp.preview" @click="startAutoTagJob(true)" :disabled="autoTagJobRunning">
            Preview Job
          </button>
          <button
            class="btn btn-secondary action-tooltip"
            :data-tooltip="bulkActionHelp.viewPreview"
            @click="viewPreviewedJob"
            :disabled="!canViewPreview"
          >
            View Preview
          </button>
          <button
            class="btn action-tooltip"
            :data-tooltip="bulkActionHelp.applyPreview"
            @click="applyPreviewedJob"
            :disabled="!canApplyPreview"
          >
            Apply Preview
          </button>
        </div>
        <div class="bulk-action-group danger-zone">
          <span>Direct write</span>
          <button class="btn action-tooltip" :data-tooltip="bulkActionHelp.applyJob" @click="startAutoTagJob(false)" :disabled="autoTagJobRunning">
            Run & Apply
          </button>
          <button class="btn btn-danger action-tooltip" :data-tooltip="bulkActionHelp.cancel" @click="cancelAutoTagJob" :disabled="!autoTagJobRunning || autoTagJob?.status === 'cancelling'">
            {{ autoTagJob?.status === 'cancelling' ? 'Cancelling...' : 'Cancel' }}
          </button>
        </div>
      </div>
    </div>
    <div class="bulk-defaults-note">
      <strong>Models used</strong>
      <span>{{ bulkPipelineSummary }}</span>
    </div>

    <div v-if="autoTagEstimate" class="estimate-strip">
      <strong>Estimate</strong>
      <span>{{ autoTagEstimate.total }} total</span>
      <span>{{ autoTagEstimate.images }} images</span>
      <span>{{ autoTagEstimate.gifs }} GIFs</span>
      <span>{{ autoTagEstimate.videos }} videos</span>
    </div>

    <div v-if="autoTagJob" class="job-panel">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: autoTagProgressPercent + '%' }"></div>
      </div>
      <p>
        {{ autoTagJob.status }}:
        {{ autoTagJob.processed }} / {{ autoTagJob.total }}
        tagged {{ autoTagJob.tagged }},
        skipped {{ autoTagJob.skipped }},
        failed {{ autoTagJob.failed }}
      </p>
      <p v-if="autoTagJob.error" class="stats-error">{{ autoTagJob.error }}</p>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsBulkJob().
  bulk: {
    type: Object,
    required: true,
  },
  // The object returned by useSettingsAutoTag().
  autoTag: {
    type: Object,
    required: true,
  },
})

const {
  autoTagMode,
  autoTagEstimate,
  autoTagJob,
  bulkActionHelp,
  autoTagJobRunning,
  canViewPreview,
  canApplyPreview,
  autoTagProgressPercent,
  bulkPipelineSummary,
  estimateAutoTags,
  startAutoTagJob,
  cancelAutoTagJob,
  viewPreviewedJob,
  applyPreviewedJob,
} = props.bulk

const { savingAutoTags, saveAutoTagSettings } = props.autoTag
</script>
<style scoped>
.info-item label {
  display: block;
  font-weight: 500;
  margin-bottom: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

/* Stats Section */
.stats-loading,
.stats-error {
  padding: 1rem;
  text-align: center;
  color: var(--text-secondary);
}

.stats-error {
  color: var(--coral);
}

.auto-status,
.job-panel {
  padding: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  margin-bottom: 1rem;
  color: var(--text-primary);
}

.config-panel {
  padding: 1rem;
  margin-top: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.config-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.9rem;
}

.config-panel-head h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.95rem;
}

.config-panel-head p {
  margin: 0;
  max-width: 560px;
  color: var(--text-secondary);
  font-size: 0.82rem;
  text-align: right;
}

.toggle-card strong,
.model-toggle-row strong {
  display: block;
  margin-bottom: 0.2rem;
  font-size: 0.9rem;
}

.field-row {
  display: grid;
  gap: 0.35rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.field-row input,
.field-row select,
.field-row textarea {
  width: 100%;
}

.bulk-toolbar {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  gap: 1rem;
  align-items: end;
}

.bulk-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(160px, 1fr));
  gap: 0.75rem;
  align-items: stretch;
}

.bulk-action-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-content: flex-start;
  min-width: 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.bulk-action-group > span {
  flex: 0 0 100%;
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1.2;
  text-transform: uppercase;
}

.bulk-action-group .btn {
  flex: 1 1 120px;
  min-width: 0;
}

.bulk-action-group.danger-zone {
  border-color: rgba(248, 113, 113, 0.35);
}

.action-tooltip {
  position: relative;
}

.action-tooltip::after {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 30;
  display: block;
  width: max-content;
  max-width: min(360px, 72vw);
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
  content: attr(data-tooltip);
  font-size: 0.78rem;
  font-weight: 500;
  line-height: 1.4;
  text-align: left;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.action-tooltip:hover::after,
.action-tooltip:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

.bulk-defaults-note {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  align-items: center;
  margin-top: 0.85rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 0.83rem;
  line-height: 1.45;
}

.bulk-defaults-note strong {
  color: var(--text-primary);
}

.estimate-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.estimate-strip strong {
  color: var(--text-primary);
}

.progress-bar {
  height: 8px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}

@media (max-width: 768px) {
  .config-panel-head,
  .semantic-manager-head,
  .pipeline-head {
    flex-direction: column;
  }

  .config-panel-head p,
  .pipeline-models {
    max-width: none;
    text-align: left;
  }

  .bulk-toolbar {
    grid-template-columns: 1fr;
  }

  .bulk-actions {
    grid-template-columns: 1fr;
  }

  .bulk-action-group .btn {
    flex: 1 1 140px;
  }
}
</style>
