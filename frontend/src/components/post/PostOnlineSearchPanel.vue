<template>
  <div class="post-tools-panel online-search-section" role="tabpanel">
    <p class="online-search-intro">
      Find where this {{ mediaType === 'video' ? 'frame' : 'image' }} came from. Each provider opens in its own tab.
    </p>
    <button class="btn btn-secondary online-exact-btn" @click="findExactOnlineMatches" :disabled="onlineExactLoading">
      {{ onlineExactLoading ? 'Checking...' : 'Exact lookup (MD5)' }}
    </button>
    <div class="online-provider-list">
      <button
        v-for="provider in onlineSearchProviders"
        :key="provider.id"
        type="button"
        class="online-match-row online-provider-row"
        :class="{ unavailable: !provider.usable }"
        :disabled="onlineSearchBusy !== ''"
        :title="provider.usable ? `Upload this ${mediaType === 'video' ? 'frame' : 'image'} to ${provider.label}` : `${provider.label} needs the NekoBooru extension`"
        @click="searchOnProvider(provider)"
      >
        <span>
          <strong>{{ provider.label }}</strong>
          <small>{{ onlineSearchBusy === provider.id ? 'Opening...' : provider.usable ? provider.hint : 'Needs the NekoBooru extension' }}</small>
        </span>
        <span aria-hidden="true">↗</span>
      </button>
    </div>
    <small class="online-search-hint">
      Exact lookup sends only an MD5 to Danbooru/Gelbooru/Sankaku. A provider gets this {{ mediaType === 'video' ? 'frame' : 'image' }} uploaded, resized if very large.
    </small>
    <p v-if="onlineSearchMessage" class="online-search-message" :class="onlineSearchMessageKind">
      {{ onlineSearchMessage }}
    </p>
    <div v-if="onlineExactResult" class="online-exact-results">
      <div class="online-exact-summary">
        <strong>
          {{ onlineExactResult.matches.length
            ? `${onlineExactResult.matches.length} exact match${onlineExactResult.matches.length === 1 ? '' : 'es'}`
            : 'No byte-exact matches' }}
        </strong>
        <code>{{ onlineExactResult.md5 }}</code>
      </div>
      <a
        v-for="match in onlineExactResult.matches"
        :key="`${match.provider}-${match.id}`"
        class="online-match-row"
        :href="match.postUrl"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span>
          <strong>{{ match.providerLabel }} #{{ match.id }}</strong>
          <small>{{ match.width && match.height ? `${match.width} × ${match.height}` : 'Dimensions unknown' }}{{ match.rating ? ` · ${match.rating}` : '' }}</small>
        </span>
        <span aria-hidden="true">↗</span>
      </a>
      <small v-if="onlineExactUnavailableProviders.length" class="online-provider-warning">
        Unavailable: {{ onlineExactUnavailableProviders.join(', ') }}. Try again later or use visual search.
      </small>
      <small v-else-if="!onlineExactResult.matches.length">
        Resizing or recompression changes the MD5; use Quick Lens or Full stack next.
      </small>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by usePostPageSearch().
  search: {
    type: Object,
    required: true,
  },
  mediaType: {
    type: String,
    default: 'image',
  },
})

const {
  onlineExactLoading,
  onlineExactResult,
  onlineSearchBusy,
  onlineSearchMessage,
  onlineSearchMessageKind,
  onlineSearchProviders,
  onlineExactUnavailableProviders,
  findExactOnlineMatches,
  searchOnProvider,
} = props.search
</script>

<style scoped>
.post-tools-panel {
  padding: 0.85rem;
}

.post-tools-panel > :first-child {
  margin-top: 0;
}

.online-search-intro {
  margin: 0 0 0.65rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
  line-height: 1.4;
}

.online-exact-btn {
  width: 100%;
}

.online-provider-list {
  display: grid;
  gap: 0.35rem;
  margin-top: 0.55rem;
}

.online-provider-row {
  width: 100%;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.online-provider-row:disabled,
.online-provider-row.unavailable {
  opacity: 0.55;
}

.online-provider-row:disabled {
  cursor: default;
}

.online-provider-row:disabled:hover {
  border-color: var(--border);
}

.online-search-hint,
.online-exact-results > small {
  display: block;
  margin-top: 0.55rem;
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.4;
}

.online-search-message {
  margin: 0.65rem 0 0;
  padding: 0.5rem 0.6rem;
  border: 1px solid rgba(34, 197, 94, 0.35);
  border-radius: 0.45rem;
  background: rgba(34, 197, 94, 0.08);
  color: #86efac;
  font-size: 0.74rem;
  line-height: 1.35;
}

.online-search-message.neutral {
  border-color: var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.online-search-message.error,
.online-provider-warning {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.08);
  color: #fca5a5;
}

.online-exact-results {
  display: grid;
  gap: 0.45rem;
  margin-top: 0.65rem;
}

.online-exact-summary {
  display: grid;
  gap: 0.25rem;
}

.online-exact-summary code {
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  font-size: 0.66rem;
}

.online-match-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  text-decoration: none;
}

.online-match-row:hover {
  border-color: var(--accent);
}

.online-match-row > span:first-child {
  display: grid;
  gap: 0.1rem;
}

.online-match-row small {
  color: var(--text-secondary);
  font-size: 0.68rem;
}
</style>
