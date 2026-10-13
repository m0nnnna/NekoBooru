<template>
  <section
    class="batch-panel"
    :class="`dock-${dock}`"
    :style="panelStyle"
  >
    <div
      class="batch-resize-handle"
      :class="`resize-${dock}`"
      :title="dock === 'right' ? 'Drag to resize panel width' : 'Drag to resize panel height'"
      @pointerdown.prevent="$emit('resize-start', $event)"
    ></div>
    <header class="batch-header">
      <div>
        <strong>{{ selectedCount }}</strong> selected
        <span>Hold a post to enter edit mode. Shift-click selects a visible range.</span>
      </div>
      <div class="batch-header-actions">
        <div class="dock-toggle" aria-label="Batch panel dock position">
          <button
            type="button"
            :class="{ active: dock === 'bottom' }"
            title="Dock batch tools at the bottom"
            @click="$emit('set-dock', 'bottom')"
          >
            Bottom
          </button>
          <button
            type="button"
            :class="{ active: dock === 'right' }"
            title="Dock batch tools on the right"
            @click="$emit('set-dock', 'right')"
          >
            Right
          </button>
        </div>
        <button type="button" class="link-btn" @click="$emit('select-page')">Select page</button>
        <button type="button" class="link-btn" @click="$emit('clear')" :disabled="!selectedCount">
          Clear selection
        </button>
        <button
          type="button"
          class="btn btn-danger"
          :disabled="!selectedCount || busy"
          :title="selectedCount ? `Delete the ${selectedCount} selected post(s)` : 'Select posts to delete'"
          @click="$emit('delete')"
        >
          Delete
        </button>
        <button type="button" class="btn btn-secondary" @click="$emit('done')">Done</button>
      </div>
    </header>

    <BatchStatus :auto-job="autoJob" :operation="operation" @cancel="$emit('cancel-job')" />

    <!-- Batch cards (AI tagging, inspector, tag edits, ...) slot in here. -->
    <div class="batch-grid">
      <slot />
    </div>
  </section>
</template>

<script setup>
import BatchStatus from './BatchStatus.vue'

// The hold-to-select edit panel: dockable/resizable shell, selection header,
// and the status of the running batch action. Cards are passed as the slot.
defineProps({
  dock: {
    type: String,
    default: 'bottom',
  },
  panelStyle: {
    type: Object,
    default: () => ({}),
  },
  selectedCount: {
    type: Number,
    default: 0,
  },
  busy: {
    type: Boolean,
    default: false,
  },
  autoJob: {
    type: Object,
    default: null,
  },
  operation: {
    type: Object,
    default: null,
  },
})

defineEmits(['resize-start', 'set-dock', 'select-page', 'clear', 'delete', 'done', 'cancel-job'])
</script>

<style scoped>
.batch-panel {
  position: sticky;
  bottom: 0;
  z-index: 20;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  box-shadow: 0 -4px 16px var(--shadow);
  overflow: auto;
  scrollbar-gutter: stable;
}

.batch-panel.dock-bottom {
  max-height: 420px;
}

.batch-panel.dock-right {
  position: fixed;
  top: 6.25rem;
  right: 1rem;
  bottom: 1rem;
  width: 440px;
  max-width: calc(100vw - 2rem);
  max-height: none;
  border-radius: 0.75rem;
  box-shadow: -8px 0 24px var(--shadow);
}

.batch-resize-handle {
  position: absolute;
  z-index: 2;
  opacity: 0.8;
  transition: opacity 0.15s, background 0.15s;
}

.batch-resize-handle:hover {
  opacity: 1;
  background: var(--accent);
}

.resize-bottom {
  top: 0;
  left: 1rem;
  right: 1rem;
  height: 7px;
  cursor: ns-resize;
}

.resize-right {
  top: 1rem;
  bottom: 1rem;
  left: 0;
  width: 7px;
  cursor: ew-resize;
}

.batch-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.batch-header > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  color: var(--text-secondary);
}

.batch-header strong {
  color: var(--text-primary);
}

.batch-header-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.dock-toggle {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-tertiary);
}

.dock-toggle button {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.45rem 0.65rem;
  font-weight: 700;
}

.dock-toggle button.active {
  background: var(--accent);
  color: white;
}

.batch-grid {
  display: grid;
  grid-template-columns: minmax(320px, 1.2fr) minmax(280px, 1fr);
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.batch-panel.dock-right .batch-header {
  align-items: stretch;
  flex-direction: column;
}

.batch-panel.dock-right .batch-grid {
  grid-template-columns: 1fr;
}

/* Right dock: the cards share one narrow column. */
.batch-panel.dock-right :deep(.ai-batch-card) {
  grid-row: auto;
}

.batch-panel.dock-right :deep(.profile-button) {
  flex-basis: 46%;
}

.batch-panel.dock-right :deep(.inspector-body) {
  grid-template-columns: 72px minmax(0, 1fr);
}

.batch-panel.dock-right :deep(.inspector-thumb) {
  width: 72px;
  height: 72px;
}

.batch-panel.dock-right :deep(.media-optimize-card .media-optimize-profiles) {
  grid-template-columns: 1fr;
}

@media (max-width: 768px) {
  .batch-header {
    align-items: stretch;
    flex-direction: column;
  }

  .batch-grid {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped src="./batchForms.css"></style>
