<template>
  <div class="post-tools-panel" role="tabpanel">
    <div class="ai-profile-actions" aria-label="AI tag preview profiles">
      <button
        v-for="profile in autoTagProfiles"
        :key="profile.id"
        type="button"
        class="btn btn-secondary ai-profile-btn"
        :class="{ active: activeAutoTagProfile === profile.id }"
        :disabled="autoTagLoading"
        :data-tooltip="profile.tooltip"
        @click="previewAutoTags(profile.id)"
      >
        {{ autoTagLoading && activeAutoTagProfile === profile.id ? 'Running...' : profile.label }}
      </button>
    </div>
    <!-- Outside the model picker: it enriches whatever the models found, and
         a control that changes the result should not sit behind a details. -->
    <label class="booru-lookup-row">
      <input type="checkbox" v-model="postAutoTagSettings.booruLookupEnabled" />
      <span>
        <strong>Look up character series on Danbooru</strong>
        <small>Adds the series for recognised characters. Only adds tags; never replaces model output.</small>
      </span>
    </label>
    <div v-if="mediaType === 'video'" class="frame-picker">
      <span class="frame-picker-label">{{ framePickerLabel }}</span>
      <button type="button" class="btn btn-secondary frame-picker-btn" @click="pinCurrentFrame">
        Analyse this frame
      </button>
      <button
        type="button"
        class="btn btn-secondary frame-picker-btn"
        :disabled="videoFrameTime === null"
        @click="videoFrameTime = null"
      >Auto</button>
    </div>
    <div v-if="autoTagLoading" class="ai-inline-status">
      <div class="ai-inline-status-head">
        <strong>{{ autoTagStageTitle }}</strong>
        <span>{{ autoTagRunElapsed }}s</span>
      </div>
      <div class="auto-progress compact">
        <div class="auto-progress-fill" :style="{ width: autoTagOverallProgress + '%' }"></div>
      </div>
      <small>{{ autoTagStageMessage }}</small>
    </div>
    <details class="ai-model-picker" :open="autoModelPickerOpen" @toggle="autoModelPickerOpen = $event.target.open">
      <summary>AI models</summary>
      <div class="ai-model-list">
        <label v-for="model in postModelRows" :key="model.id" class="ai-model-row">
          <input
            type="checkbox"
            v-model="postAutoTagSettings[model.settingKey]"
            :disabled="!model.canToggle"
          />
          <span>
            <strong class="ai-model-name">
              {{ model.name }}
              <button
                type="button"
                class="ai-info-icon"
                :data-tooltip="postModelInfoTitle(model)"
                :aria-label="postModelInfoTitle(model)"
                @mouseenter="showModelTooltip($event, postModelInfoTitle(model))"
                @focus="showModelTooltip($event, postModelInfoTitle(model))"
                @mouseleave="hideModelTooltip"
                @blur="hideModelTooltip"
                @click.prevent
              >i</button>
            </strong>
            <small>
              {{ model.statusLabel }}
              · {{ model.loaded ? 'loaded' : 'not loaded' }}
            </small>
          </span>
          <button
            type="button"
            class="btn btn-secondary ai-load-btn"
            @click.prevent="model.loaded ? unloadAutoTagWeights(model.id) : loadAutoTagWeights(model.id)"
            :disabled="autoTagLoading || !model.downloaded || !model.runtimeAvailable"
          >
            {{ model.loaded ? 'Unload' : 'Load' }}
          </button>
        </label>
      </div>
    </details>

    <Teleport to="body">
      <div
        v-if="modelTooltip.visible"
        class="ai-model-tooltip-layer"
        :style="{ top: modelTooltip.top + 'px', left: modelTooltip.left + 'px' }"
      >
        {{ modelTooltip.text }}
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { postModelInfoTitle } from '../../composables/usePostPageAiModels'

const props = defineProps({
  // The object returned by usePostPageAutoTag().
  autoTag: {
    type: Object,
    required: true,
  },
  mediaType: {
    type: String,
    default: 'image',
  },
})

const {
  autoTagProfiles,
  activeAutoTagProfile,
  autoTagLoading,
  postAutoTagSettings,
  videoFrameTime,
  framePickerLabel,
  autoTagStageTitle,
  autoTagRunElapsed,
  autoTagOverallProgress,
  autoTagStageMessage,
  autoModelPickerOpen,
  postModelRows,
  modelTooltip,
  previewAutoTags,
  pinCurrentFrame,
  showModelTooltip,
  hideModelTooltip,
  loadAutoTagWeights,
  unloadAutoTagWeights,
} = props.autoTag
</script>

<style scoped>
.post-tools-panel {
  padding: 0.85rem;
}

.post-tools-panel > :first-child {
  margin-top: 0;
}

.ai-profile-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
  margin-top: 0.75rem;
}

.ai-profile-btn {
  position: relative;
  min-width: 0;
  padding: 0.55rem 0.45rem;
  font-size: 0.78rem;
  line-height: 1.2;
  white-space: normal;
}

.ai-profile-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.ai-profile-btn::after {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 80;
  display: block;
  width: max-content;
  max-width: min(320px, 76vw);
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.38);
  content: attr(data-tooltip);
  font-size: 0.74rem;
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.ai-profile-btn:hover::after,
.ai-profile-btn:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

.ai-inline-status {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.ai-inline-status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.45rem;
  color: var(--text-primary);
  font-size: 0.82rem;
}

.ai-inline-status-head span,
.ai-inline-status small {
  color: var(--text-secondary);
  font-size: 0.74rem;
}

.ai-model-picker {
  margin-top: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.frame-picker {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.frame-picker-label {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.frame-picker-btn {
  padding: 0.3rem 0.55rem;
  font-size: 0.75rem;
  white-space: nowrap;
}

.booru-lookup-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: flex-start;
  gap: 0.55rem;
  margin-top: 0.75rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
}

.booru-lookup-row input {
  margin-top: 0.2rem;
}

.booru-lookup-row strong {
  display: block;
  font-size: 0.85rem;
}

.booru-lookup-row small {
  display: block;
  margin-top: 0.15rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.35;
}

.ai-model-picker summary {
  cursor: pointer;
  padding: 0.65rem 0.75rem;
  color: var(--text-primary);
  font-weight: 600;
  font-size: 0.9rem;
}

.ai-model-list {
  display: grid;
  gap: 0.5rem;
  padding: 0 0.75rem 0.75rem;
}

.ai-model-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.ai-model-row small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.72rem;
  margin-top: 0.1rem;
}

.ai-model-name {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.ai-info-icon {
  position: relative;
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: help;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 15px;
}

.ai-info-icon:hover,
.ai-info-icon:focus-visible {
  color: var(--text-primary);
  border-color: var(--accent);
}

.ai-load-btn {
  padding: 0.35rem 0.55rem;
  font-size: 0.78rem;
  min-width: 58px;
}

.ai-model-tooltip-layer {
  position: fixed;
  z-index: 5000;
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
  font-size: 0.76rem;
  font-weight: 500;
  line-height: 1.4;
  text-align: left;
  white-space: pre-line;
  pointer-events: none;
}

.auto-progress {
  height: 10px;
  background: var(--bg-secondary);
  border-radius: 5px;
  overflow: hidden;
  margin: 1rem 0 0.5rem;
}

.auto-progress.compact {
  height: 7px;
  margin: 0 0 0.45rem;
  background: rgba(148, 163, 184, 0.18);
}

.auto-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}

</style>
