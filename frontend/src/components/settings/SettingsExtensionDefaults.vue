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
