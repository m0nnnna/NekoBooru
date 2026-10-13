<template>
  <BatchCard
    class="media-optimize-card"
    title="Media Optimizer"
    description="Preview quality-controlled outputs, inspect impact, then replace originals."
  >
    <div class="batch-optimize-body">
      <div class="batch-optimize-topline">
        <div>
          <strong>Optimization profile</strong>
          <small>{{ batchOptimizeProfileName }} settings</small>
        </div>
        <span class="batch-optimize-state" :class="batchOptimizeState">{{ batchOptimizeStateLabel }}</span>
      </div>

      <MediaOptimizeProfiles
        :profiles="mediaOptimizeProfiles"
        :active-profile="batchOptimizeProfile"
        :compact="compact"
        @select="applyBatchOptimizeProfile"
      />

      <div class="batch-optimize-inventory">
        <div>
          <span>Selected</span>
          <strong>{{ batchOptimizeInventory.total }}</strong>
        </div>
        <div>
          <span>Images</span>
          <strong>{{ batchOptimizeInventory.images }}</strong>
        </div>
        <div>
          <span>Videos</span>
          <strong>{{ batchOptimizeInventory.videos }}</strong>
        </div>
        <div>
          <span>Source storage</span>
          <strong>{{ formatFileSize(batchOptimizeInventory.bytes) }}</strong>
        </div>
      </div>

      <div class="batch-optimize-policy">
        <div>
          <span>Image policy</span>
          <strong>{{ Number(batchImageMaxDimension || 0).toLocaleString() }}px · quality {{ batchImageQuality }}</strong>
        </div>
        <div>
          <span>Video policy</span>
          <strong>
            {{ batchOptimizeIsSocial
              ? 'MP4 · H.264 High · AAC-LC · ≤40 FPS'
              : `${Number(batchVideoMaxDimension || 0).toLocaleString()}px · ${Number(batchVideoBitrateKbps || 0).toLocaleString()} kbps`
            }}
          </strong>
        </div>
      </div>

      <details class="batch-optimize-advanced">
        <summary>
          <span>Advanced controls</span>
          <small>Override dimensions and quality budgets</small>
        </summary>
        <div class="batch-field-grid compact">
          <label>
            Image target
            <select v-model="batchImagePreset" @change="applyBatchImagePreset">
              <option v-for="option in batchImagePresetOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            Image quality
            <input type="number" min="1" max="100" step="1" v-model.number="batchImageQuality" @input="markBatchOptimizeCustom" />
          </label>
          <label>
            Video target
            <select v-model="batchVideoPreset" @change="applyBatchVideoPreset">
              <option v-for="option in batchVideoPresetOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            Video quality budget
            <select v-model="batchVideoBitratePreset" @change="applyBatchVideoBitratePreset">
              <option v-for="option in batchVideoBitratePresetOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label v-if="batchImagePreset === 'custom'">
            Custom image max side
            <input type="number" min="64" max="8192" step="16" v-model.number="batchImageMaxDimension" @input="markBatchOptimizeCustom" />
          </label>
          <label v-if="batchVideoPreset === 'custom'">
            Custom video max side
            <input type="number" min="64" max="8192" step="16" v-model.number="batchVideoMaxDimension" @input="markBatchOptimizeCustom" />
          </label>
          <label v-if="batchVideoBitratePreset === 'custom'">
            Custom video budget (kbps)
            <input type="number" min="64" max="50000" step="64" v-model.number="batchVideoBitrateKbps" @input="markBatchOptimizeCustom" />
          </label>
        </div>
      </details>

      <div class="batch-optimize-guardrail">
        <strong>Protected replacement workflow</strong>
        <span>
          <template v-if="batchOptimizeIsSocial">
            Social mode preserves accepted source dimensions and creates H.264/AAC MP4 files. Outputs may be
            larger when that is required to avoid visible generational loss. Account duration and file-size
            limits still apply on X.
          </template>
          <template v-else>
            Quality-first encodes may burst during complex scenes. Originals are changed only when the output is
            valid, unique, and smaller than the current file.
          </template>
        </span>
      </div>

      <div v-if="batchOptimizePreview" class="batch-optimize-review">
        <div class="batch-optimize-review-head">
          <div>
            <span>Preview assessment</span>
            <strong>{{ batchOptimizePreviewAssessment }}</strong>
          </div>
          <span>{{ batchOptimizeCanApply ? 'Ready to set' : 'Current retained' }}</span>
        </div>
        <div class="batch-optimize-review-metrics">
          <div>
            <span>Original</span>
            <strong>{{ formatFileSize(batchOptimizePreviewSavings.before) }}</strong>
          </div>
          <div>
            <span>{{ batchOptimizeIsSocial ? 'Compatible' : batchOptimizeCanApply ? 'Optimized' : 'Reviewed' }}</span>
            <strong>{{ formatFileSize(batchOptimizePreviewSavings.after) }}</strong>
          </div>
          <div>
            <span>Would change</span>
            <strong>{{ batchOptimizePreview.optimized || 0 }}</strong>
          </div>
          <div>
            <span>Skipped</span>
            <strong>{{ batchOptimizePreview.skipped || 0 }}</strong>
          </div>
          <div>
            <span>Failed</span>
            <strong :class="{ danger: batchOptimizePreview.failed }">{{ batchOptimizePreview.failed || 0 }}</strong>
          </div>
        </div>

        <div v-if="batchOptimizePreviewChanges.length" class="batch-optimize-results">
          <div
            v-for="item in batchOptimizePreviewChanges"
            :key="item.postId"
            class="batch-optimize-result-row"
          >
            <div>
              <strong>Post #{{ item.postId }}</strong>
              <small>
                {{ formatFileSize(item.oldSize) }} → {{ formatFileSize(item.newSize) }}
                <template v-if="item.width && item.height"> · {{ item.width }} × {{ item.height }}</template>
              </small>
              <small v-if="batchOptimizeGrowthExplanation(item)" class="batch-optimize-growth-note">
                {{ batchOptimizeGrowthExplanation(item) }}
              </small>
            </div>
            <button
              v-if="item.previewUrl"
              type="button"
              class="link-btn"
              @click="openBatchOptimizePreview(item)"
            >
              Open preview
            </button>
          </div>
        </div>
      </div>

      <div class="batch-actions-row batch-optimize-actions">
        <button type="button" class="btn" :disabled="!selectedCount || busy" @click="openOrCreateBatchOptimizePreview">
          {{ busy ? 'Processing...' : 'Preview' }}
        </button>
        <button
          type="button"
          class="btn btn-danger"
          :disabled="!selectedCount || busy || !batchOptimizeCanApply"
          :title="batchOptimizeCanApply ? 'Set the exact reviewed files as the stored originals' : 'Preview valid results before setting them'"
          @click="batchOptimizeConfirmOpen = true"
        >
          Set
        </button>
      </div>
    </div>
  </BatchCard>
</template>

<script setup>
import BatchCard from './BatchCard.vue'
import MediaOptimizeProfiles from '../MediaOptimizeProfiles.vue'
import { formatFileSize } from '../../utils/format'
import { batchOptimizeGrowthExplanation } from '../../composables/useBatchMediaOptimize'

const props = defineProps({
  // The object returned by useBatchMediaOptimize().
  optimizer: {
    type: Object,
    required: true,
  },
  selectedCount: {
    type: Number,
    default: 0,
  },
  busy: {
    type: Boolean,
    default: false,
  },
  compact: {
    type: Boolean,
    default: false,
  },
})

const {
  mediaOptimizeProfiles,
  batchImageMaxDimension,
  batchImageQuality,
  batchVideoMaxDimension,
  batchVideoBitrateKbps,
  batchOptimizeProfile,
  batchImagePreset,
  batchVideoPreset,
  batchVideoBitratePreset,
  batchImagePresetOptions,
  batchVideoPresetOptions,
  batchVideoBitratePresetOptions,
  batchOptimizeProfileName,
  batchOptimizeIsSocial,
  batchOptimizeInventory,
  batchOptimizePreview,
  batchOptimizePreviewSavings,
  batchOptimizePreviewChanges,
  batchOptimizePreviewAssessment,
  batchOptimizeCanApply,
  batchOptimizeState,
  batchOptimizeStateLabel,
  batchOptimizeConfirmOpen,
  applyBatchOptimizeProfile,
  applyBatchImagePreset,
  applyBatchVideoPreset,
  applyBatchVideoBitratePreset,
  markBatchOptimizeCustom,
  openBatchOptimizePreview,
  openOrCreateBatchOptimizePreview,
} = props.optimizer
</script>

<style scoped>
.batch-optimize-body {
  display: grid;
  gap: 0.75rem;
}

.batch-optimize-topline,
.batch-optimize-review-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.batch-optimize-topline > div,
.batch-optimize-review-head > div {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}

.batch-optimize-topline strong,
.batch-optimize-review-head strong {
  color: var(--text-primary);
  font-size: 0.86rem;
}

.batch-optimize-topline small {
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.batch-optimize-state,
.batch-optimize-review-head > span {
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

.batch-optimize-state.running {
  border-color: rgba(96, 165, 250, 0.55);
  color: var(--accent);
}

.batch-optimize-state.ready,
.batch-optimize-review-head > span {
  border-color: rgba(129, 178, 154, 0.6);
  background: var(--success-soft);
  color: var(--success);
}

.batch-optimize-state.error {
  border-color: rgba(224, 122, 95, 0.6);
  background: var(--coral-soft);
  color: var(--coral);
}

.batch-optimize-inventory,
.batch-optimize-review-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.5rem;
}

.batch-optimize-inventory > div,
.batch-optimize-review-metrics > div {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
  padding: 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
}

.batch-optimize-inventory span,
.batch-optimize-policy span,
.batch-optimize-review-metrics span,
.batch-optimize-review-head span:first-child {
  color: var(--text-secondary);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.035em;
  text-transform: uppercase;
}

.batch-optimize-inventory strong,
.batch-optimize-policy strong,
.batch-optimize-review-metrics strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-optimize-policy {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.batch-optimize-policy > div {
  display: grid;
  gap: 0.12rem;
  padding: 0.65rem;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: 0.55rem;
  background: var(--accent-soft);
}

.batch-optimize-advanced {
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: var(--bg-secondary);
}

.batch-optimize-advanced > summary {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.65rem;
  cursor: pointer;
  list-style: none;
  color: var(--text-primary);
}

.batch-optimize-advanced > summary::-webkit-details-marker {
  display: none;
}

.batch-optimize-advanced > summary span {
  color: var(--text-primary);
  font-size: 0.82rem;
  font-weight: 700;
}

.batch-optimize-advanced > summary small {
  color: var(--text-secondary);
  font-size: 0.7rem;
}

.batch-optimize-advanced .batch-field-grid {
  margin-top: 0;
  padding: 0 0.65rem 0.65rem;
}

.batch-optimize-guardrail {
  display: grid;
  gap: 0.18rem;
  padding: 0.7rem;
  border: 1px solid rgba(129, 178, 154, 0.5);
  border-radius: 0.6rem;
  background: var(--success-soft);
}

.batch-optimize-guardrail strong {
  color: var(--text-primary);
  font-size: 0.78rem;
}

.batch-optimize-guardrail span {
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.4;
}

.batch-optimize-review {
  display: grid;
  gap: 0.65rem;
  padding: 0.75rem;
  border: 1px solid rgba(129, 178, 154, 0.55);
  border-radius: 0.65rem;
  background: var(--success-soft);
}

.batch-optimize-review-head strong {
  font-size: 1rem;
}

.batch-optimize-review-metrics {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.batch-optimize-review-metrics .danger {
  color: var(--coral);
}

.batch-optimize-results {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--bg-secondary);
}

.batch-optimize-result-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0.65rem;
}

.batch-optimize-result-row + .batch-optimize-result-row {
  border-top: 1px solid var(--border);
}

.batch-optimize-result-row > div {
  display: grid;
  min-width: 0;
  gap: 0.1rem;
}

.batch-optimize-result-row strong {
  color: var(--text-primary);
  font-size: 0.76rem;
}

.batch-optimize-result-row small {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.batch-optimize-result-row .batch-optimize-growth-note {
  color: var(--warning, #f2c14e);
  line-height: 1.35;
}

.batch-optimize-result-row .link-btn {
  flex: 0 0 auto;
  font-weight: 700;
}

.batch-optimize-actions .btn {
  flex: 1 1 180px;
}

@media (max-width: 768px) {
  .batch-optimize-inventory,
  .batch-optimize-review-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .batch-optimize-policy {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped src="./batchForms.css"></style>
