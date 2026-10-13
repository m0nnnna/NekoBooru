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
.profile-buttons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.5rem;
}

.profile-buttons,
.batch-ai-custom {
  margin-top: 0.85rem;
}

.profile-button {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  padding: 0.6rem 0.7rem;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
}

.profile-button:hover {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
}

.profile-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.profile-button.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent);
}

.profile-button strong,
.profile-button span {
  display: block;
}

.profile-button strong {
  font-size: 0.86rem;
  font-weight: 600;
}

.profile-button span {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.74rem;
  line-height: 1.35;
  margin-top: 0.15rem;
  text-overflow: ellipsis;
}

.batch-ai-custom {
  display: grid;
  gap: 0.5rem;
}
</style>

<style scoped src="./batchForms.css"></style>
