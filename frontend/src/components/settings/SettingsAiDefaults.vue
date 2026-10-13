<template>
  <p class="section-description">
    Default model checkboxes used by per-post AI Tag, the upload form, browser extension previews, and custom profile starts.
    You can still override them per run.
  </p>

  <div class="profile-defaults-grid">
    <div
      v-for="profile in aiDefaultProfiles"
      :key="profile.id"
      class="extension-defaults-panel profile-default-card"
    >
      <div class="extension-defaults-head">
        <div>
          <strong>{{ profile.name }}</strong>
          <small>{{ profile.description }}</small>
        </div>
        <span>{{ aiDefaultModelSummary(profile.id) }}</span>
      </div>
      <div class="extension-model-grid">
        <label
          v-for="model in aiDefaultModels"
          :key="`${profile.id}-${model.key}`"
          class="toggle-card extension-model-toggle"
        >
          <input
            type="checkbox"
            v-model="aiModelProfileDefaults[profile.id][model.key]"
            @change="aiModelDefaultsPersisted = true"
          />
          <span>
            <strong>{{ model.name }}</strong>
            <small>{{ profileModelDescription(profile.id, model) }}</small>
          </span>
        </label>
      </div>
    </div>
  </div>

  <p v-if="aiModelDefaultsStatus.show" class="cookies-status" :class="aiModelDefaultsStatus.success ? 'success' : 'error'">
    <strong>{{ aiModelDefaultsStatus.message }}</strong>
  </p>

  <div class="form-actions">
    <button class="btn" @click="saveAiModelDefaults" :disabled="savingAiModelDefaults">
      {{ savingAiModelDefaults ? 'Saving...' : 'Save AI Model Defaults' }}
    </button>
  </div>
</template>

<script setup>
import { profileModelDescription } from '../../composables/useSettingsAiModels'

const props = defineProps({
  // The object returned by useSettingsAiModels().
  aiModels: {
    type: Object,
    required: true,
  },
})

const {
  aiModelProfileDefaults,
  aiModelDefaultsPersisted,
  savingAiModelDefaults,
  aiModelDefaultsStatus,
  saveAiModelDefaults,
  aiDefaultModels,
  aiDefaultProfiles,
  aiDefaultModelSummary,
} = props.aiModels
</script>
<style scoped>
.section-description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-bottom: 1.5rem;
}

.migration-status.error,
.cookies-status.error {
  background: var(--coral-soft);
  border-color: var(--coral);
  color: var(--text-primary);
}

.cookies-status {
  margin: 1rem 0;
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
}

.cookies-status.success {
  background: var(--success-soft);
  border-color: var(--success);
  color: var(--text-primary);
}

.form-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1.5rem;
}

.info-item label {
  display: block;
  font-weight: 500;
  margin-bottom: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.extension-defaults-panel {
  margin-top: 1rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.profile-defaults-grid {
  display: grid;
  gap: 1rem;
}

.profile-default-card {
  background: rgba(255, 255, 255, 0.02);
}

.extension-defaults-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.extension-defaults-head strong,
.extension-defaults-head small {
  display: block;
}

.extension-defaults-head small,
.extension-defaults-head span {
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.extension-model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0.75rem;
}

.extension-model-toggle {
  background: var(--bg-primary);
}

.toggle-card,
.model-toggle-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.toggle-card input,
.model-toggle-row input {
  margin-top: 0.15rem;
}

.toggle-card strong,
.model-toggle-row strong {
  display: block;
  margin-bottom: 0.2rem;
  font-size: 0.9rem;
}

.toggle-card small,
.model-toggle-row small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}
</style>
