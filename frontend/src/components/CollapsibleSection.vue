<template>
  <section class="settings-section" :class="{ 'is-open': open }">
    <button
      type="button"
      class="section-toggle"
      :aria-expanded="open ? 'true' : 'false'"
      @click="$emit('toggle')"
    >
      <span class="section-chevron" aria-hidden="true"></span>
      <h2>{{ title }}</h2>
    </button>
    <div v-show="open" class="section-body">
      <slot />
    </div>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  open: { type: Boolean, default: false },
})
defineEmits(['toggle'])
</script>

<style scoped>
.settings-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  margin-bottom: 1rem;
  overflow: hidden;
}

.section-toggle {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 1.1rem 1.5rem;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.section-toggle:hover .section-chevron,
.section-toggle:hover h2 {
  color: var(--text-primary);
}

.section-toggle:focus-visible {
  outline: 2px solid var(--primary, #6c8cff);
  outline-offset: -2px;
}

.section-toggle h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 1.15rem;
}

/* CSS-only chevron so the component stays dependency-free. */
.section-chevron {
  flex: none;
  width: 0.5rem;
  height: 0.5rem;
  border-right: 2px solid var(--text-secondary);
  border-bottom: 2px solid var(--text-secondary);
  transform: rotate(-45deg);
  transition: transform 0.15s ease;
}

.is-open .section-chevron {
  transform: rotate(45deg);
}

.section-body {
  padding: 0 1.5rem 1.5rem;
}

@media (max-width: 600px) {
  .section-toggle {
    padding: 1rem;
  }

  .section-body {
    padding: 0 1rem 1rem;
  }
}
</style>
