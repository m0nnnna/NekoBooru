<template>
  <div v-if="authStore.canBrowseBoorus" ref="rootRef" class="source-picker">
    <button
      type="button"
      class="source-button"
      :class="{ open, remote: store.remoteSites.length > 0 }"
      aria-haspopup="true"
      :aria-expanded="open"
      :title="`Search sources: ${summary}`"
      @click="open = !open"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </svg>
      <span class="source-label">{{ summary }}</span>
    </button>

    <div v-if="open" class="source-menu" role="menu" aria-label="Search sources">
      <p class="source-menu-title">Search in</p>
      <div v-for="source in sourceRows" :key="source.id" class="source-row">
        <label
          class="source-option"
          :class="{ disabled: source.disabled }"
          :title="source.hint"
        >
          <input
            type="checkbox"
            :checked="source.ticked"
            :disabled="source.disabled || source.locked"
            @change="store.toggle(source.id)"
          />
          <span class="source-name">{{ source.label }}</span>
          <small v-if="source.hint" class="source-hint">{{ source.hint }}</small>
        </label>
        <span v-if="source.ratings" class="rating-toggles" role="group" :aria-label="`${source.label} ratings`">
          <button
            v-for="rating in source.ratings"
            :key="rating.level"
            type="button"
            class="rating-toggle"
            :class="[rating.level, { active: rating.on }]"
            :aria-pressed="rating.on ? 'true' : 'false'"
            :aria-label="rating.label"
            :title="rating.label"
            @click="store.toggleRating(source.id, rating.level)"
          ></button>
        </span>
      </div>

      <div class="source-layout" role="radiogroup" aria-label="Result layout">
        <span>Results</span>
        <label :class="{ active: store.layout === 'grouped' }">
          <input type="radio" name="booru-layout" value="grouped" :checked="store.layout === 'grouped'" @change="store.setLayout('grouped')" />
          Grouped
        </label>
        <label :class="{ active: store.layout === 'interleaved' }">
          <input type="radio" name="booru-layout" value="interleaved" :checked="store.layout === 'interleaved'" @change="store.setLayout('interleaved')" />
          Interleaved
        </label>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../../api/client'
import { useAuthStore } from '../../stores/auth'
import { useRemoteSourcesStore } from '../../stores/remoteSources'
import { LIBRARY_SOURCE, SAFETY_ORDER, SOURCE_IDS, siteById } from '../../remote/types.js'

// The search-source button next to the header search bar (section 4.1 of
// docs/booru-search-plan.md): NekoBooru plus the boorus as checkboxes, and
// the grouped/interleaved switch. Each booru row also has three rating
// toggles (safe / sketchy / explicit, the home view's safety colours) that
// narrow the global safety filter for that booru only. Exists only for users
// who may browse boorus; Gelbooru is greyed out until the server has its API key.
const authStore = useAuthStore()
const store = useRemoteSourcesStore()

const open = ref(false)
const rootRef = ref(null)
const status = ref(null)
let statusRequested = false

const RATING_WORDS = { safe: 'safe', sketchy: 'sketchy', unsafe: 'explicit' }

function ratingButtons(id, label) {
  const allowed = store.siteRatings(id)
  return SAFETY_ORDER.map((level) => ({
    level,
    on: allowed[level] !== false,
    label: `${label}: ${allowed[level] !== false ? 'hide' : 'show'} ${RATING_WORDS[level]}`,
  }))
}

function labelFor(id) {
  return id === LIBRARY_SOURCE ? 'NekoBooru' : siteById(id)?.label || id
}

const sourceRows = computed(() => SOURCE_IDS.map((id) => {
  const ticked = store.sources.includes(id)
  const gelbooruMissing = id === 'gelbooru' && status.value?.gelbooruConfigured === false
  const label = labelFor(id)
  return {
    id,
    label,
    ticked,
    // The library keeps following the global filter alone.
    ratings: id === LIBRARY_SOURCE ? null : ratingButtons(id, label),
    // An unticked Gelbooru without a key cannot be ticked; a ticked one
    // (saved before the key was removed) can still be unticked.
    disabled: gelbooruMissing && !ticked,
    // The last ticked source stays ticked.
    locked: ticked && store.sources.length === 1,
    hint: gelbooruMissing ? 'needs an API key in Settings' : '',
  }
}))

const summary = computed(() => {
  const names = store.sources.map(labelFor)
  if (names.length === 1) return names[0]
  return `${names[0]} +${names.length - 1}`
})

async function loadStatus() {
  if (statusRequested || !authStore.canBrowseBoorus) return
  statusRequested = true
  try {
    status.value = await api.getBooruSearchStatus()
  } catch {
    // Without the status every source stays tickable; the Gelbooru section
    // then reports the missing key itself.
    status.value = null
  }
}

function onDocumentPointerDown(event) {
  if (open.value && rootRef.value && !rootRef.value.contains(event.target)) open.value = false
}

function onKeyDown(event) {
  if (event.key === 'Escape' && open.value) open.value = false
}

watch(() => authStore.canBrowseBoorus, (allowed) => {
  if (allowed) loadStatus()
  else open.value = false
})

onMounted(() => {
  loadStatus()
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped>
.source-picker {
  position: relative;
}

.source-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 38px;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
  font-size: 0.875rem;
}

.source-button:hover,
.source-button.open {
  border-color: var(--accent);
}

.source-button.remote {
  color: var(--accent);
}

.source-button svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
}

.source-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 0.25rem;
  z-index: 100;
  min-width: 240px;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  box-shadow: 0 4px 12px var(--shadow);
  color: var(--text-primary);
}

.source-menu-title {
  padding: 0.25rem 0.5rem;
  color: var(--text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.source-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.source-row .source-option {
  flex: 1;
  min-width: 0;
}

.rating-toggles {
  display: flex;
  gap: 0.25rem;
  padding-right: 0.35rem;
}

/* The home view's safety-filter squares, smaller. */
.rating-toggle {
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 3px;
  opacity: 0.3;
}

.rating-toggle.active {
  opacity: 1;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.rating-toggle:hover {
  transform: scale(1.1);
}

.rating-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.rating-toggle.safe {
  background: #4ade80;
}

.rating-toggle.sketchy {
  background: #facc15;
}

.rating-toggle.unsafe {
  background: #f87171;
}

.source-option {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  column-gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: 0.35rem;
  cursor: pointer;
}

.source-option:hover {
  background: var(--bg-tertiary);
}

.source-option.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.source-hint {
  grid-column: 2;
  color: var(--text-muted);
  font-size: 0.75rem;
}

.source-layout {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.35rem;
  padding: 0.5rem 0.5rem 0.25rem;
  border-top: 1px solid var(--border);
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.source-layout label {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
}

.source-layout label.active {
  color: var(--accent);
}

/* The label goes with the header's user name (App.vue); the button's title
   still names the ticked sources. */
@media (max-width: 1500px) {
  .source-label {
    display: none;
  }
}

@media (max-width: 768px) {
  .source-button {
    padding: 0 0.6rem;
  }

  .source-menu {
    position: fixed;
    top: 60px; /* below the sticky header, like the search suggestions */
    left: 0.5rem;
    right: 0.5rem;
    min-width: 0;
    max-height: 70vh;
    overflow-y: auto;
  }
}
</style>
