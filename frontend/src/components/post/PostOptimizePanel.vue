<template>
  <div class="post-tools-panel" role="tabpanel">
    <div class="post-optimize-menu">
      <div class="post-optimize-summary">
        <span>
          <strong>Media Optimizer</strong>
          <small>Quality-controlled, review-first replacement</small>
        </span>
        <span class="optimize-state-badge" :class="postOptimizeState">
          {{ postOptimizeStateLabel }}
        </span>
      </div>

      <div class="post-optimize-body">
        <section class="optimize-section">
          <div class="optimize-section-head">
            <div>
              <strong>Optimization profile</strong>
              <small>{{ postOptimizeProfileName }} settings</small>
            </div>
            <span v-if="postOptimizeProfile === 'custom'" class="optimize-custom-badge">Custom</span>
          </div>
          <MediaOptimizeProfiles
            :profiles="mediaOptimizeProfiles"
            :active-profile="postOptimizeProfile"
            compact
            @select="applyPostOptimizeProfile"
          />
        </section>

        <div class="optimize-context-grid">
          <div class="optimize-context-card">
            <span>Source</span>
            <strong>{{ postOptimizeSourceResolution }}</strong>
            <small>{{ formatFileSize(post.fileSize) }}{{ postOptimizeIsVideo && postCurrentVideoBitrate ? ` · ~${postCurrentVideoBitrate.toLocaleString()} kbps` : '' }}</small>
          </div>
          <div class="optimize-context-card target">
            <span>Target policy</span>
            <strong>{{ postOptimizeTargetResolution }}</strong>
            <small>{{ postOptimizeTargetDetail }}</small>
          </div>
        </div>

        <details class="optimize-advanced">
          <summary>
            <span>Advanced controls</span>
            <small>Fine-tune dimensions and quality budgets</small>
          </summary>
          <div class="post-optimize-grid">
            <label v-if="postOptimizeIsImage">
              Image target
              <select v-model="postImagePreset" @change="applyPostImagePreset">
                <option v-for="option in postImagePresetOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label v-if="postOptimizeIsImage">
              Image quality
              <input type="number" min="1" max="100" step="1" v-model.number="postImageQuality" @input="markPostOptimizeCustom" />
            </label>
            <label v-if="postOptimizeIsVideo">
              Video target
              <select v-model="postVideoPreset" @change="applyPostVideoPreset">
                <option v-for="option in postVideoPresetOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label v-if="postOptimizeIsVideo">
              Video quality budget
              <select v-model="postVideoBitratePreset" @change="applyPostVideoBitratePreset">
                <option v-for="option in postVideoBitratePresetOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label v-if="postOptimizeIsImage && postImagePreset === 'custom'">
              Custom image max side
              <input type="number" min="64" max="8192" step="16" v-model.number="postImageMaxDimension" @input="markPostOptimizeCustom" />
            </label>
            <label v-if="postOptimizeIsVideo && postVideoPreset === 'custom'">
              Custom video max side
              <input type="number" min="64" max="8192" step="16" v-model.number="postVideoMaxDimension" @input="markPostOptimizeCustom" />
            </label>
            <label v-if="postOptimizeIsVideo && postVideoBitratePreset === 'custom'">
              Custom video budget (kbps)
              <input type="number" min="64" max="50000" step="64" v-model.number="postVideoBitrateKbps" @input="markPostOptimizeCustom" />
            </label>
          </div>
        </details>

        <div class="optimize-guardrail">
          <span class="optimize-guardrail-icon" aria-hidden="true">✓</span>
          <div>
            <strong>Quality and replacement guardrails</strong>
            <small>
              <template v-if="postOptimizeIsSocial">
                Social mode preserves accepted source dimensions, creates an H.264/AAC MP4, and may increase
                file size to avoid visible generational loss. X account duration and file-size limits still apply.
              </template>
              <template v-else>
                Motion can burst above the selected video budget. The original is replaced only after a valid,
                smaller output passes media inspection and duplicate checks.
              </template>
            </small>
          </div>
        </div>

        <div
          v-if="optimizePreview"
          class="optimize-review-card"
          :class="{ growth: optimizePreviewSavings.increaseBytes > 0 }"
        >
          <div class="optimize-review-head">
            <div>
              <span>Preview assessment</span>
              <strong>{{ optimizePreviewAssessment }}</strong>
            </div>
            <span class="optimize-ready-pill">{{ optimizePreviewCanApply ? 'Ready to set' : 'Current retained' }}</span>
          </div>
          <div class="optimize-review-metrics">
            <div>
              <span>Original</span>
              <strong>{{ formatFileSize(optimizePreviewSavings.before) }}</strong>
            </div>
            <div>
              <span>{{ optimizePreviewCanApply ? 'Optimized' : 'Reviewed' }}</span>
              <strong>{{ formatFileSize(optimizePreviewSavings.after) }}</strong>
            </div>
            <div>
              <span>{{ optimizePreviewStorageLabel }}</span>
              <strong>{{ formatFileSize(optimizePreviewStorageBytes) }}</strong>
            </div>
          </div>
          <small>{{ optimizePreviewDimensionSummary }}</small>
          <small v-if="optimizePreviewGrowthExplanation" class="optimize-growth-explanation">
            {{ optimizePreviewGrowthExplanation }}
          </small>
        </div>

        <div v-if="showOptimizeJobCard" class="optimize-job-card" :class="{ error: optimizeStatusKind === 'error' }">
          <div class="optimize-job-head">
            <div>
              <strong>{{ optimizeBusy ? 'Optimization job running' : 'Optimization job' }}</strong>
              <small>{{ optimizeStatus || optimizeJob.message }}</small>
            </div>
            <span>{{ optimizeJobProgress }}%</span>
          </div>
          <div class="post-optimize-progress" role="progressbar" :aria-valuenow="optimizeJobProgress" aria-valuemin="0" aria-valuemax="100">
            <div class="post-optimize-progress-fill" :style="{ width: optimizeJobProgress + '%' }"></div>
          </div>
        </div>

        <div class="optimize-action-bar">
          <button
            type="button"
            class="btn"
            :disabled="optimizeBusy"
            @click="openOrCreateOptimizePreview"
          >
            {{ optimizeBusy ? 'Processing...' : 'Preview' }}
          </button>
          <button
            type="button"
            class="btn btn-danger"
            :disabled="optimizeBusy || !optimizePreviewCanApply"
            :title="optimizePreviewCanApply ? 'Set the exact reviewed file as the stored original' : 'Preview a valid result before setting it'"
            @click="requestSetOptimizePreview"
          >
            Set
          </button>
        </div>

        <small v-if="optimizeStatus && !optimizeJob" class="post-optimize-status" :class="{ error: optimizeStatusKind === 'error' }">
          {{ optimizeStatus }}
        </small>
      </div>
    </div>
  </div>
</template>

<script setup>
import MediaOptimizeProfiles from '../MediaOptimizeProfiles.vue'
import { formatFileSize } from '../../composables/usePostPageFormat'

const props = defineProps({
  post: {
    type: Object,
    required: true,
  },
  // The object returned by usePostPageOptimize().
  optimize: {
    type: Object,
    required: true,
  },
})

const {
  mediaOptimizeProfiles,
  postOptimizeProfile,
  postOptimizeProfileName,
  postOptimizeState,
  postOptimizeStateLabel,
  postOptimizeSourceResolution,
  postOptimizeTargetResolution,
  postOptimizeTargetDetail,
  postOptimizeIsImage,
  postOptimizeIsVideo,
  postOptimizeIsSocial,
  postCurrentVideoBitrate,
  postImagePreset,
  postImagePresetOptions,
  postImageQuality,
  postImageMaxDimension,
  postVideoPreset,
  postVideoPresetOptions,
  postVideoBitratePreset,
  postVideoBitratePresetOptions,
  postVideoMaxDimension,
  postVideoBitrateKbps,
  optimizePreview,
  optimizePreviewSavings,
  optimizePreviewAssessment,
  optimizePreviewCanApply,
  optimizePreviewStorageLabel,
  optimizePreviewStorageBytes,
  optimizePreviewDimensionSummary,
  optimizePreviewGrowthExplanation,
  showOptimizeJobCard,
  optimizeStatus,
  optimizeStatusKind,
  optimizeBusy,
  optimizeJob,
  optimizeJobProgress,
  applyPostOptimizeProfile,
  applyPostImagePreset,
  applyPostVideoPreset,
  applyPostVideoBitratePreset,
  markPostOptimizeCustom,
  openOrCreateOptimizePreview,
  requestSetOptimizePreview,
} = props.optimize
</script>

<style scoped>
.post-tools-panel {
  padding: 0.85rem;
}

.post-tools-panel > :first-child {
  margin-top: 0;
}

/* Sits inside the Optimize tab, whose panel already draws the frame. */
.post-optimize-menu {
  min-width: 0;
}

.post-optimize-summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0 0 0.75rem;
  color: var(--text-primary);
}

.post-optimize-summary::-webkit-details-marker {
  display: none;
}

.post-optimize-summary > span:first-child {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}

.post-optimize-summary strong {
  font-size: 0.92rem;
}

.post-optimize-summary small {
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.3;
}

.optimize-state-badge,
.optimize-custom-badge,
.optimize-ready-pill {
  flex: 0 0 auto;
  padding: 0.2rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.64rem;
  font-weight: 800;
  letter-spacing: 0.025em;
  text-transform: uppercase;
}

.optimize-state-badge.running {
  border-color: rgba(96, 165, 250, 0.55);
  color: var(--accent);
}

.optimize-state-badge.ready,
.optimize-ready-pill {
  border-color: rgba(129, 178, 154, 0.65);
  background: var(--success-soft);
  color: var(--success);
}

.optimize-state-badge.error {
  border-color: rgba(224, 122, 95, 0.65);
  background: var(--coral-soft);
  color: var(--coral);
}

.post-optimize-body {
  display: grid;
  gap: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.optimize-section {
  display: grid;
  gap: 0.55rem;
  padding-top: 0.75rem;
}

.optimize-section-head,
.optimize-review-head,
.optimize-job-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.optimize-section-head > div,
.optimize-review-head > div,
.optimize-job-head > div {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}

.optimize-section-head strong,
.optimize-review-head strong,
.optimize-job-head strong {
  color: var(--text-primary);
  font-size: 0.82rem;
}

.optimize-section-head small,
.optimize-job-head small {
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.35;
}

.optimize-context-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.55rem;
}

.optimize-context-card {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
  padding: 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.07);
}

.optimize-context-card.target {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: var(--accent-soft);
}

.optimize-context-card span,
.optimize-review-metrics span,
.optimize-confirm-impact span {
  color: var(--text-secondary);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.optimize-context-card strong {
  min-width: 0;
  color: var(--text-primary);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.optimize-context-card small {
  color: var(--text-secondary);
  font-size: 0.66rem;
  line-height: 1.35;
}

.optimize-advanced {
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.06);
}

.optimize-advanced > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  flex-direction: column;
  padding: 0.65rem;
}

.optimize-advanced > summary::-webkit-details-marker {
  display: none;
}

.optimize-advanced > summary span {
  color: var(--text-primary);
  font-size: 0.8rem;
  font-weight: 700;
}

.optimize-advanced > summary small {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.post-optimize-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.55rem;
  padding: 0 0.65rem 0.65rem;
}

.post-optimize-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.post-optimize-grid input,
.post-optimize-grid select {
  min-width: 0;
  width: 100%;
  color: var(--text-primary);
}

.optimize-guardrail {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.6rem;
  padding: 0.65rem;
  border: 1px solid rgba(129, 178, 154, 0.45);
  border-radius: 0.6rem;
  background: var(--success-soft);
}

.optimize-guardrail-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--success);
  color: white;
  font-size: 0.75rem;
  font-weight: 900;
}

.optimize-guardrail > div {
  display: grid;
  gap: 0.15rem;
}

.optimize-guardrail strong {
  color: var(--text-primary);
  font-size: 0.76rem;
}

.optimize-guardrail small {
  color: var(--text-secondary);
  font-size: 0.68rem;
  line-height: 1.4;
}

.optimize-review-card,
.optimize-job-card {
  display: grid;
  gap: 0.6rem;
  padding: 0.7rem;
  border: 1px solid rgba(129, 178, 154, 0.55);
  border-radius: 0.65rem;
  background: linear-gradient(135deg, var(--success-soft), rgba(0, 0, 0, 0.05));
}

.optimize-review-head span:first-child {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.optimize-review-head strong {
  font-size: 1rem;
}

.optimize-review-metrics,
.optimize-confirm-impact {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
}

.optimize-review-metrics > div,
.optimize-confirm-impact > div {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
}

.optimize-review-metrics strong,
.optimize-confirm-impact strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.77rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.optimize-review-card > small {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.optimize-review-card.growth {
  border-color: color-mix(in srgb, var(--warning, #f2c14e) 68%, var(--border));
  background: linear-gradient(135deg, rgba(242, 193, 78, 0.12), rgba(0, 0, 0, 0.05));
}

.optimize-review-card .optimize-growth-explanation {
  padding: 0.55rem 0.6rem;
  border: 1px solid color-mix(in srgb, var(--warning, #f2c14e) 40%, var(--border));
  border-radius: 0.45rem;
  background: color-mix(in srgb, var(--warning, #f2c14e) 8%, transparent);
  color: var(--text-primary);
  line-height: 1.4;
}

.optimize-job-card {
  border-color: rgba(96, 165, 250, 0.45);
  background: var(--accent-soft);
}

.optimize-job-card.error {
  border-color: rgba(224, 122, 95, 0.55);
  background: var(--coral-soft);
}

.optimize-job-head > span {
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 800;
}

.optimize-action-bar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.optimize-action-bar .btn {
  min-width: 0;
  padding-inline: 0.7rem;
  font-size: 0.78rem;
}

.post-optimize-status {
  display: block;
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.35;
}

.post-optimize-progress {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.post-optimize-progress-fill {
  height: 100%;
  min-width: 4px;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.25s ease;
}

.post-optimize-status.error {
  color: var(--coral, #f87171);
}

@media (max-width: 768px) {
  .post-optimize-menu {
    flex: 1 1 100%;
  }

  .optimize-context-grid,
  .optimize-review-metrics,
  .optimize-confirm-impact,
  .optimize-apply-mode {
    grid-template-columns: 1fr;
  }

  .optimize-action-bar {
    grid-template-columns: 1fr;
  }
}
</style>
