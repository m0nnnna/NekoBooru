<template>
  <details class="batch-card" :open="open">
    <summary class="batch-card-header">
      <span class="batch-card-heading">
        <span class="batch-card-title">{{ title }}</span>
        <span v-if="description" class="batch-card-desc" :title="description">{{ description }}</span>
      </span>
      <svg class="batch-card-chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </summary>
    <div class="batch-card-body">
      <slot />
    </div>
  </details>
</template>

<script setup>
// One collapsible section of the batch edit panel: a title, a one-line muted
// description, and the card's controls as the slot.
defineProps({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: '',
  },
  open: {
    type: Boolean,
    default: true,
  },
})
</script>

<style scoped>
.batch-card {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--bg-card);
  color: var(--text-primary);
  box-shadow: 0 1px 2px var(--shadow);
}

.batch-card-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.85rem;
  border-radius: 0.65rem;
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: background 0.15s;
}

.batch-card-header::-webkit-details-marker {
  display: none;
}

.batch-card-header:hover {
  background: color-mix(in srgb, var(--bg-tertiary) 55%, transparent);
}

.batch-card-header:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.batch-card[open] > .batch-card-header {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.batch-card-heading {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  gap: 0.1rem;
}

.batch-card-title {
  color: var(--text-primary);
  font-size: 0.9rem;
  font-weight: 600;
  line-height: 1.3;
}

.batch-card-desc {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-card-chevron {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  fill: none;
  stroke: var(--text-secondary);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 0.15s;
}

.batch-card[open] > .batch-card-header .batch-card-chevron {
  transform: none;
}

.batch-card-body {
  padding: 0.85rem;
  border-top: 1px solid var(--border);
}

/* The body's padding sets the gap; the first control needs no extra margin. */
.batch-card-body > :slotted(:first-child) {
  margin-top: 0;
}
</style>
