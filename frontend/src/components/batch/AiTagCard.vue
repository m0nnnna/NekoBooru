<template>
  <BatchCard
    class="ai-batch-card"
    title="AI Tag Selected"
    description="Run a profile or custom model stack on only the selected posts."
  >
    <div class="profile-buttons">
      <button
        v-for="profile in batchAiProfiles"
        :key="profile.id"
        type="button"
        class="profile-button"
        :class="{ active: batchAiProfile === profile.id }"
        :title="profile.help"
        @click="batchAiProfile = profile.id"
      >
        <strong>{{ profile.label }}</strong>
        <span>{{ profile.short }}</span>
      </button>
    </div>
    <div v-if="batchAiProfile === 'custom'" class="batch-ai-custom">
      <label v-for="model in batchModelOptions" :key="model.key" class="batch-check">
        <input type="checkbox" v-model="batchAiSettings[model.key]" />
        <span>
          <strong>{{ model.label }}</strong>
          <small>{{ model.help }}</small>
        </span>
      </label>
      <div class="batch-field-grid">
        <label>
          General threshold
          <input type="number" min="0" max="1" step="0.01" v-model.number="batchAiSettings.generalThreshold" />
        </label>
        <label>
          Character threshold
          <input type="number" min="0" max="1" step="0.01" v-model.number="batchAiSettings.characterThreshold" />
        </label>
        <label>
          Unsafe threshold
          <input type="number" min="0" max="1" step="0.01" v-model.number="batchAiSettings.unsafeThreshold" />
        </label>
        <label>
          Sketchy threshold
          <input type="number" min="0" max="1" step="0.01" v-model.number="batchAiSettings.sketchyThreshold" />
        </label>
        <label>
          Max tags
          <input type="number" min="1" max="100" step="1" v-model.number="batchAiSettings.maxTags" />
        </label>
        <label>
          Video frames
          <input type="number" min="1" max="12" step="1" v-model.number="batchAiSettings.videoMaxFrames" />
        </label>
      </div>
      <label class="batch-check">
        <input type="checkbox" v-model="batchAiSettings.applySafety" />
        <span>
          <strong>Apply safety rating</strong>
          <small>Allow the model to promote selected posts to sketchy or unsafe.</small>
        </span>
      </label>
      <label class="batch-textarea-label">
        Semantic prompt
        <textarea
          v-model="batchAiSettings.semanticPrompt"
          rows="4"
          placeholder="Prompt used when Qwen semantic tags are enabled..."
        ></textarea>
      </label>
    </div>
    <div class="batch-actions-row">
      <button type="button" class="btn btn-secondary" :disabled="!selectedCount || busy" @click="runBatchAutoTag(true)">
        Preview Job
      </button>
      <button type="button" class="btn btn-primary" :disabled="!selectedCount || busy" @click="runBatchAutoTag(false)">
        Run & Apply
      </button>
    </div>
    <p class="batch-note">
      Preview Job stores suggestions for review. Run & Apply writes tags and safety as each selected post finishes.
    </p>
  </BatchCard>
</template>

<script setup>
import BatchCard from './BatchCard.vue'

const props = defineProps({
  // The object returned by useBatchAiTagging().
  ai: {
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
})

const {
  batchAiProfile,
  batchAiProfiles,
  batchAiSettings,
  batchModelOptions,
  runBatchAutoTag,
} = props.ai
</script>

<style scoped>
.ai-batch-card {
  grid-row: span 2;
}

.profile-buttons {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.profile-buttons,
.batch-ai-custom {
  margin-top: 0.75rem;
}

.profile-button {
  flex: 1 1 140px;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  padding: 0.75rem;
  cursor: pointer;
  text-align: left;
}

.profile-button.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.profile-button strong,
.profile-button span {
  display: block;
}

.profile-button span {
  color: var(--text-secondary);
  font-size: 0.82rem;
  margin-top: 0.2rem;
}

.batch-ai-custom {
  display: grid;
  gap: 0.6rem;
}

@media (max-width: 768px) {
  .ai-batch-card {
    grid-row: auto;
  }
}
</style>

<style scoped src="./batchForms.css"></style>
