<template>
  <section
    class="batch-panel"
    :class="`dock-${dock}`"
    :style="panelStyle"
    aria-label="Batch edit"
  >
    <div
      class="batch-resize-handle"
      :class="`resize-${dock}`"
      :title="dock === 'right' ? 'Drag to resize panel width' : 'Drag to resize panel height'"
      @pointerdown.prevent="$emit('resize-start', $event)"
    ></div>

    <header class="batch-header">
      <div class="batch-heading">
        <h2 class="batch-title">
          <span class="batch-count">{{ selectedCount }}</span>
          <span>{{ selectedLabel }}</span>
        </h2>
        <span class="batch-hint" :title="hint">{{ hint }}</span>
      </div>

      <div class="batch-toolbar">
        <div class="batch-toolbar-group" role="group" aria-label="Selection">
          <button type="button" class="tb-btn tb-ghost" title="Add every post on this page to the selection" @click="$emit('select-page')">
            Select page
          </button>
          <button
            type="button"
            class="tb-btn tb-ghost"
            title="Deselect everything"
            :disabled="!selectedCount"
            @click="$emit('clear')"
          >
            Clear
          </button>
        </div>

        <span class="tb-divider" aria-hidden="true"></span>

        <div class="dock-toggle" role="group" aria-label="Batch panel dock position">
          <button
            type="button"
            :class="{ active: dock === 'bottom' }"
            :aria-pressed="dock === 'bottom'"
            aria-label="Dock at the bottom"
            title="Dock batch tools at the bottom"
            @click="$emit('set-dock', 'bottom')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 14h18" />
            </svg>
          </button>
          <button
            type="button"
            :class="{ active: dock === 'right' }"
            :aria-pressed="dock === 'right'"
            aria-label="Dock on the right"
            title="Dock batch tools on the right"
            @click="$emit('set-dock', 'right')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M14 4v16" />
            </svg>
          </button>
        </div>

        <div class="batch-toolbar-group batch-toolbar-end">
          <button
            type="button"
            class="tb-btn tb-danger"
            :disabled="!deletable || busy"
            :title="deletable ? `Delete the ${deletable} selected post(s)` : 'Select posts to delete'"
            @click="$emit('delete')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
            </svg>
            Delete
          </button>
          <button type="button" class="tb-btn tb-primary" title="Leave edit mode" @click="$emit('done')">
            Done
          </button>
        </div>
      </div>
    </header>

    <div class="batch-body">
      <BatchStatus :auto-job="autoJob" :operation="operation" @cancel="$emit('cancel-job')" />

      <!-- Batch cards (AI tagging, inspector, tag edits, ...) slot in here. -->
      <div class="batch-grid">
        <slot name="remote" />
        <slot />
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import BatchStatus from './BatchStatus.vue'

// The hold-to-select edit panel: dockable/resizable shell, selection toolbar,
// and the status of the running batch action. Cards are passed as the slot;
// cards for selected booru posts (the Import card) go first, in #remote.
const props = defineProps({
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
  // With booru posts selected: { library, remote } for the header's
  // "N selected · X library · Y remote". Delete only ever sees library posts.
  breakdown: {
    type: Object,
    default: null,
  },
})

defineEmits(['resize-start', 'set-dock', 'select-page', 'clear', 'delete', 'done', 'cancel-job'])

const deletable = computed(() => (props.breakdown ? props.breakdown.library : props.selectedCount))
const selectedLabel = computed(() => (props.breakdown
  ? `selected · ${props.breakdown.library} library · ${props.breakdown.remote} remote`
  : 'selected'))

const hint = 'Hold a post to enter edit mode. Shift-click selects a visible range.'
</script>

<style scoped>
.batch-panel {
  position: sticky;
  bottom: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  box-shadow: 0 -6px 24px var(--shadow-lg);
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
  box-shadow: -8px 0 28px var(--shadow-lg);
}

.batch-resize-handle {
  position: absolute;
  z-index: 3;
  border-radius: 999px;
  transition: background 0.15s;
}

.batch-resize-handle::after {
  content: '';
  position: absolute;
  border-radius: 999px;
  background: var(--border);
  transition: background 0.15s;
}

.batch-resize-handle:hover::after {
  background: var(--accent);
}

.resize-bottom {
  top: 0;
  left: 1rem;
  right: 1rem;
  height: 9px;
  cursor: ns-resize;
}

.resize-bottom::after {
  top: 3px;
  left: 50%;
  width: 44px;
  height: 4px;
  transform: translateX(-50%);
}

.resize-right {
  top: 1rem;
  bottom: 1rem;
  left: 0;
  width: 9px;
  cursor: ew-resize;
}

.resize-right::after {
  left: 3px;
  top: 50%;
  width: 4px;
  height: 44px;
  transform: translateY(-50%);
}

/* --- Header / toolbar --- */
.batch-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.6rem 1rem;
  padding: 0.85rem 1rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.batch-heading {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  min-width: 0;
}

.batch-title {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
  margin: 0;
  color: var(--text-primary);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
}

.batch-count {
  color: var(--accent);
  font-size: 1.25rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.batch-hint {
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.batch-toolbar-group {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.batch-toolbar-end {
  gap: 0.5rem;
  margin-left: 0.25rem;
}

.tb-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
}

.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  height: 32px;
  padding: 0 0.8rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.84rem;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.tb-btn svg,
.dock-toggle svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.tb-btn:focus-visible,
.dock-toggle button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.tb-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.tb-ghost {
  color: var(--text-secondary);
}

.tb-ghost:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.tb-danger {
  border-color: color-mix(in srgb, var(--coral) 55%, transparent);
  color: color-mix(in srgb, var(--coral) 80%, var(--text-primary));
}

.tb-danger:hover:not(:disabled) {
  border-color: var(--coral);
  background: var(--coral);
  color: #fff;
}

.tb-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.tb-primary:hover:not(:disabled) {
  border-color: var(--accent-hover);
  background: var(--accent-hover);
}

.dock-toggle {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.dock-toggle button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 26px;
  border: none;
  border-radius: 0.35rem;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.dock-toggle button:hover {
  color: var(--text-primary);
}

.dock-toggle button.active {
  background: var(--bg-card);
  color: var(--accent);
  box-shadow: 0 1px 3px var(--shadow-lg);
}

/* --- Body --- */
.batch-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0.85rem 1rem 1rem;
  scrollbar-gutter: stable;
}

/* Wide (bottom) dock: as many ~360px columns as fit, cards top-aligned. */
.batch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr));
  align-items: start;
  gap: 0.75rem;
}

.batch-body > :deep(.batch-status) {
  margin-bottom: 0.85rem;
}

/* Right dock: one narrow column. */
.batch-panel.dock-right .batch-hint {
  display: none;
}

/* Two rows: title + dock toggle, then selection controls + Delete/Done. */
.batch-panel.dock-right .batch-toolbar {
  display: contents;
}

.batch-panel.dock-right .tb-divider {
  display: none;
}

.batch-panel.dock-right .batch-heading {
  flex: 1 1 0;
  order: 0;
}

.batch-panel.dock-right .dock-toggle {
  order: 1;
}

.batch-panel.dock-right .batch-header::after {
  content: '';
  flex-basis: 100%;
  order: 2;
}

.batch-panel.dock-right .batch-toolbar-group {
  order: 3;
  margin-left: -0.5rem;
}

.batch-panel.dock-right .batch-toolbar-end {
  order: 4;
  margin-left: auto;
}

.batch-panel.dock-right .batch-grid {
  grid-template-columns: 1fr;
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
  /* Same two-row header as the right dock. */
  .batch-hint,
  .tb-divider {
    display: none;
  }

  .batch-toolbar {
    display: contents;
  }

  .batch-heading {
    flex: 1 1 0;
    order: 0;
  }

  .dock-toggle {
    order: 1;
  }

  .batch-header::after {
    content: '';
    flex-basis: 100%;
    order: 2;
  }

  .batch-toolbar-group {
    order: 3;
    margin-left: -0.5rem;
  }

  .batch-toolbar-end {
    order: 4;
    margin-left: auto;
  }

  .tb-btn {
    padding: 0 0.6rem;
  }

  .batch-grid {
    grid-template-columns: 1fr;
  }
}
</style>
