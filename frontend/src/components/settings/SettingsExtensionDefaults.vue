<template>
  <p class="section-description">
    Defaults used by the upload popup. You can still override these per upload in the extension window.
  </p>

  <label class="toggle-card">
    <input type="checkbox" v-model="extensionSettings.saveTweetTag" />
    <span>
      <strong>Save tweet/booru post ID as tag</strong>
      <small>
        Adds tags like <code>twitter_2063698076431200361</code> when uploading from X/Twitter, or
        <code>danbooru_12345</code> when uploading from a supported booru's post page.
      </small>
    </span>
  </label>
  <label class="toggle-card">
    <input type="checkbox" v-model="extensionSettings.saveTweetUsername" />
    <span>
      <strong>Save tweet username as tag</strong>
      <small>Adds tags like <code>twitter_user_username</code> when uploading from X/Twitter.</small>
    </span>
  </label>
  <label class="toggle-card">
    <input type="checkbox" v-model="extensionSettings.saveSourcePageUrl" />
    <span>
      <strong>Save source page URL</strong>
      <small>Saves the page where the media was found, including non-tweet pages.</small>
    </span>
  </label>
  <label class="toggle-card">
    <input type="checkbox" v-model="extensionSettings.saveMediaUrl" />
    <span>
      <strong>Save image/media URL when no page URL is saved</strong>
      <small>Uses the direct image or video URL as the post source if the page URL option is off or unavailable.</small>
    </span>
  </label>
  <label class="toggle-card">
    <input type="checkbox" v-model="extensionSettings.saveSemanticAnalysis" />
    <span>
      <strong>Save Qwen semantic analysis</strong>
      <small>When an extension AI preview uses Qwen, stores its rationale and raw semantic output for semantic search.</small>
    </span>
  </label>

  <p v-if="extensionStatus.show" class="cookies-status" :class="extensionStatus.success ? 'success' : 'error'">
    <strong>{{ extensionStatus.message }}</strong>
  </p>

  <div class="form-actions">
    <button class="btn" @click="saveExtensionSettings" :disabled="savingExtension">
      {{ savingExtension ? 'Saving...' : 'Save Extension Defaults' }}
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsPreferences().
  prefs: {
    type: Object,
    required: true,
  },
})

const { extensionSettings, savingExtension, extensionStatus, saveExtensionSettings } = props.prefs
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

.info-item code {
  display: block;
  font-family: 'Courier New', monospace;
  font-size: 0.8rem;
  color: var(--text-primary);
  word-break: break-all;
  background: var(--bg-primary);
  padding: 0.5rem;
  border-radius: 0.25rem;
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
