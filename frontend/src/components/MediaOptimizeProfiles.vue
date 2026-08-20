<template>
  <div
    class="media-optimize-profiles"
    :class="{ compact }"
    role="radiogroup"
    aria-label="Optimization profile"
  >
    <button
      v-for="profile in profiles"
      :key="profile.id"
      type="button"
      class="media-optimize-profile"
      :class="{ active: activeProfile === profile.id }"
      :aria-checked="activeProfile === profile.id"
      role="radio"
      @click="$emit('select', profile.id)"
    >
      <span class="media-optimize-profile-head">
        <strong>{{ profile.label }}</strong>
        <small>{{ profile.badge }}</small>
      </span>
      <span>{{ profile.description }}</span>
    </button>
  </div>
</template>

<script setup>
defineProps({
  profiles: {
    type: Array,
    required: true,
  },
  activeProfile: {
    type: String,
    default: 'balanced',
  },
  compact: {
    type: Boolean,
    default: false,
  },
})

defineEmits(['select'])
</script>

<style scoped>
.media-optimize-profiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.55rem;
}

.media-optimize-profile {
  min-width: 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: color-mix(in srgb, var(--bg-primary) 76%, transparent);
  color: var(--text-primary);
  text-align: left;
}

.media-optimize-profile:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.media-optimize-profile.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent);
}

.media-optimize-profile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.media-optimize-profile-head strong {
  color: var(--text-primary);
  font-size: 0.87rem;
}

.media-optimize-profile-head small {
  flex: 0 0 auto;
  padding: 0.12rem 0.35rem;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.media-optimize-profile > span:last-child {
  display: block;
  margin-top: 0.35rem;
  color: var(--text-secondary);
  font-size: 0.74rem;
  line-height: 1.35;
}

.media-optimize-profiles.compact {
  grid-template-columns: 1fr;
}

.media-optimize-profiles.compact .media-optimize-profile {
  padding: 0.65rem 0.7rem;
}

.media-optimize-profiles.compact .media-optimize-profile-head {
  justify-content: flex-start;
}

.media-optimize-profiles.compact .media-optimize-profile-head small {
  margin-left: auto;
}

.media-optimize-profiles.compact .media-optimize-profile > span:last-child {
  margin-top: 0.2rem;
  font-size: 0.7rem;
}

@media (max-width: 720px) {
  .media-optimize-profiles {
    grid-template-columns: 1fr;
  }
}
</style>
