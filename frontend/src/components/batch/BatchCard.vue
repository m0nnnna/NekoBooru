<template>
  <details class="batch-card" :open="open">
    <summary>
      <span>{{ title }}</span>
      <small>{{ description }}</small>
    </summary>
    <slot />
  </details>
</template>

<script setup>
// One collapsible section of the batch edit panel.
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
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.08);
  padding: 0.8rem;
}

.batch-card summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--text-primary);
}

.batch-card summary::-webkit-details-marker {
  display: none;
}

.batch-card summary span::before {
  content: '▸';
  display: inline-block;
  margin-right: 0.35rem;
  transition: transform 0.15s;
}

.batch-card[open] summary span::before {
  transform: rotate(90deg);
}

.batch-card summary small {
  color: var(--text-secondary);
}
</style>
