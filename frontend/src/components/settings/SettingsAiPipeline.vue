<template>
  <div class="config-panel">
    <div class="config-panel-head">
      <h3>Compute location</h3>
      <p>Run models in this server, or offload to a GPU machine on your LAN.</p>
    </div>
    <label class="toggle-card">
      <input type="checkbox" v-model="autoTagSettings.remoteEnabled" @change="saveAutoTagSettings" />
      <span>
        <strong>Run AI on a remote GPU worker</strong>
        <small>Forwards tagging to another NekoBooru instance that has the AI stack installed. This server stays light.</small>
      </span>
    </label>
    <div v-if="autoTagSettings.remoteEnabled" class="remote-worker-config">
      <div class="form-group">
        <label>Worker URL</label>
        <input
          v-model="autoTagSettings.remoteUrl"
          type="text"
          placeholder="http://192.168.1.50:8772"
          autocomplete="off"
          class="path-input"
        />
        <p class="help-text">The base URL of the GPU machine's NekoBooru (no trailing path).</p>
      </div>
      <div class="form-group">
        <label>Worker token</label>
        <div class="path-input-group">
          <input
            v-model="workerToken"
            type="password"
            placeholder="Shared secret (recommended)"
            autocomplete="off"
            class="path-input"
          />
          <button class="btn btn-secondary" @click="saveWorkerToken" :disabled="savingWorkerToken || !workerToken.trim()">
            {{ savingWorkerToken ? 'Saving...' : 'Save Token' }}
          </button>
          <button class="btn btn-secondary" @click="deleteWorkerToken" :disabled="savingWorkerToken || !autoTagStatus.remote?.tokenConfigured">
            Forget
          </button>
        </div>
        <p class="help-text">
          Must match <code>NEKO_TAGGER_WORKER_TOKEN</code> on the worker. Stored locally; sent as a header on each call.
        </p>
      </div>
      <div class="form-actions">
        <button class="btn" @click="testWorker" :disabled="testingWorker || !autoTagSettings.remoteUrl">
          {{ testingWorker ? 'Testing...' : 'Test connection' }}
        </button>
        <span class="status-note" :class="autoTagStatus.remote?.reachable ? 'model-ok' : 'model-missing'">
          {{ remoteWorkerSummary }}
        </span>
      </div>
    </div>
  </div>

  <div v-if="!autoTagSettings.remoteEnabled" class="config-panel">
    <div class="config-panel-head">
      <h3>Compute Runtime</h3>
      <p>Choose where large torch models run. Auto prefers GPU when CUDA torch is installed.</p>
    </div>
    <div class="numeric-grid">
      <label class="field-row">
        <span class="label-with-help">
          Torch device
          <button type="button" class="info-icon" :data-tooltip="torchDeviceHelp" :aria-label="torchDeviceHelp">?</button>
        </span>
        <select v-model="autoTagSettings.torchDevice">
          <option value="auto">Auto</option>
          <option value="gpu">GPU only</option>
          <option value="cpu">CPU only</option>
        </select>
      </label>
      <div class="runtime-card">
        <strong>{{ torchSummary }}</strong>
        <small>{{ torchDeviceDetail }}</small>
      </div>
    </div>
  </div>

  <div class="config-panel">
    <div class="config-panel-head">
      <h3>Automation Scope</h3>
      <p>Choose where automatic tagging is allowed to run and what metadata it may update.</p>
    </div>
    <div class="toggle-grid">
      <label class="toggle-card">
        <input type="checkbox" v-model="autoTagSettings.tagImages" />
        <span>
          <strong>Images</strong>
          <small>Run image models on JPG, PNG, GIF, and WebP posts.</small>
        </span>
      </label>
      <label class="toggle-card">
        <input type="checkbox" v-model="autoTagSettings.tagVideos" />
        <span>
          <strong>Videos</strong>
          <small>Sample frames and optional audio/text context from video posts.</small>
        </span>
      </label>
      <label class="toggle-card">
        <input type="checkbox" v-model="autoTagSettings.applySafety" />
        <span>
          <strong>Safety updates</strong>
          <small>Promote posts to sketchy or unsafe when model evidence supports it.</small>
        </span>
      </label>
    </div>
  </div>

  <div class="config-panel">
    <div class="config-panel-head">
      <h3>Thresholds</h3>
      <p>Tune sensitivity, tag volume, and video frame sampling.</p>
    </div>
    <div class="numeric-grid">
      <label class="field-row">
        <span class="label-with-help">
          General threshold
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.general" :aria-label="thresholdHelp.general">?</button>
        </span>
        <input type="number" min="0" max="1" step="0.01" v-model.number="autoTagSettings.generalThreshold" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Character threshold
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.character" :aria-label="thresholdHelp.character">?</button>
        </span>
        <input type="number" min="0" max="1" step="0.01" v-model.number="autoTagSettings.characterThreshold" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Unsafe threshold
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.unsafe" :aria-label="thresholdHelp.unsafe">?</button>
        </span>
        <input type="number" min="0" max="1" step="0.01" v-model.number="autoTagSettings.unsafeThreshold" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Sketchy threshold
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.sketchy" :aria-label="thresholdHelp.sketchy">?</button>
        </span>
        <input type="number" min="0" max="1" step="0.01" v-model.number="autoTagSettings.sketchyThreshold" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Max tags
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.maxTags" :aria-label="thresholdHelp.maxTags">?</button>
        </span>
        <input type="number" min="1" max="200" v-model.number="autoTagSettings.maxTags" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Visual tagger frames
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.videoFrames" :aria-label="thresholdHelp.videoFrames">?</button>
        </span>
        <input type="number" min="1" max="8" v-model.number="autoTagSettings.videoMaxFrames" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Qwen frame cap
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.qwenVideoFrames" :aria-label="thresholdHelp.qwenVideoFrames">?</button>
        </span>
        <input type="number" min="1" max="64" v-model.number="autoTagSettings.qwenVideoMaxFrames" :disabled="!autoTagSettings.qwenVideoUseFps" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Light tag cutoff
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.lightCutoff" :aria-label="thresholdHelp.lightCutoff">?</button>
        </span>
        <input type="number" min="0" max="50" v-model.number="autoTagSettings.lightlyTaggedMaxTags" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Similar-post distance
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.similarDistance" :aria-label="thresholdHelp.similarDistance">?</button>
        </span>
        <input type="number" min="0" max="64" v-model.number="autoTagSettings.inheritSimilarMaxDistance" :disabled="!autoTagSettings.inheritSimilarTags" />
      </label>
      <label class="field-row">
        <span class="label-with-help">
          Similar-post min tags
          <button type="button" class="info-icon" :data-tooltip="thresholdHelp.similarMinTags" :aria-label="thresholdHelp.similarMinTags">?</button>
        </span>
        <input type="number" min="0" max="50" v-model.number="autoTagSettings.inheritSimilarMinTags" :disabled="!autoTagSettings.inheritSimilarTags" />
      </label>
    </div>
    <label class="field-row toggle-row" style="margin-top:0.5rem">
      <input type="checkbox" v-model="autoTagSettings.inheritSimilarTags" />
      <span class="label-with-help">
        Inherit tags from similar posts
        <button type="button" class="info-icon" :data-tooltip="thresholdHelp.inheritSimilar" :aria-label="thresholdHelp.inheritSimilar">?</button>
      </span>
    </label>
    <div class="qwen-video-sampling">
      <label class="toggle-card">
        <input type="checkbox" v-model="autoTagSettings.qwenVideoUseFps" />
        <span>
          <strong>Use Qwen 2 FPS video sampling</strong>
          <small>Off uses one representative middle frame. On samples at 2 FPS up to the frame cap and sends Qwen one contact-sheet prompt for temporal reasoning.</small>
        </span>
      </label>
      <div class="sampling-facts">
        <span>
          <strong>Mode</strong>
          {{ autoTagSettings.qwenVideoUseFps ? '2 FPS capped sampling' : 'Single middle frame' }}
        </span>
        <span>
          <strong>Qwen frames</strong>
          {{ autoTagSettings.qwenVideoUseFps ? `Up to ${autoTagSettings.qwenVideoMaxFrames || 20}` : '1' }}
        </span>
        <span>
          <strong>Prompt input</strong>
          {{ autoTagSettings.qwenVideoUseFps ? 'One contact sheet, one semantic pass' : 'One resized frame, one semantic pass' }}
        </span>
        <span>
          <strong>Visible summary</strong>
          Hides sample counts, timestamps, and frame labels.
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsAutoTag().
  autoTag: {
    type: Object,
    required: true,
  },
})

const {
  autoTagSettings,
  autoTagStatus,
  workerToken,
  savingWorkerToken,
  testingWorker,
  thresholdHelp,
  torchDeviceHelp,
  remoteWorkerSummary,
  torchSummary,
  torchDeviceDetail,
  saveAutoTagSettings,
  saveWorkerToken,
  deleteWorkerToken,
  testWorker,
} = props.autoTag
</script>
<style scoped>
.help-text code {
  background: var(--bg-secondary);
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.8rem;
}

.config-panel {
  padding: 1rem;
  margin-top: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.qwen-video-sampling {
  display: grid;
  gap: 0.75rem;
  margin-top: 0.9rem;
}

.sampling-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.6rem;
}

.sampling-facts span {
  display: grid;
  gap: 0.25rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.sampling-facts strong {
  color: var(--text-muted);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.runtime-card {
  display: grid;
  gap: 0.35rem;
  align-self: end;
  min-height: 72px;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.runtime-card strong {
  color: var(--text-primary);
}

.runtime-card small {
  color: var(--text-secondary);
  line-height: 1.4;
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
}
</style>
