<template>
  <div class="sidebar-section post-info">
    <div class="post-info-head">
      <div class="post-info-id">
        <strong>#{{ post.id }}</strong>
        <span v-if="post.extension" class="post-info-type">{{ String(post.extension).replace(/^\./, '') }}</span>
      </div>
      <time class="post-info-date" :datetime="post.createdAt" :title="formatFullDate(post.createdAt)">
        {{ formatRelativeDate(post.createdAt) }}
      </time>
    </div>

    <div class="post-info-meta">
      <span title="Dimensions">{{ post.width }} × {{ post.height }}</span>
      <span class="post-info-dot" aria-hidden="true">·</span>
      <span title="File size">{{ formatFileSize(post.fileSize) }}</span>
    </div>

    <div v-if="tweetUrl || pixivUrl || booruSourceLink" class="post-info-sources">
      <a
        v-if="tweetUrl"
        class="post-info-chip"
        :href="tweetUrl"
        target="_blank"
        rel="noopener noreferrer"
        title="Open on X"
        aria-label="Open on X"
      >
        <svg class="post-info-chip-logo" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
        </svg>
        <span aria-hidden="true">↗</span>
      </a>
      <a v-if="pixivUrl" class="post-info-chip" :href="pixivUrl" target="_blank" rel="noopener noreferrer">
        Pixiv <span aria-hidden="true">↗</span>
      </a>
      <a
        v-if="booruSourceLink"
        class="post-info-chip"
        :href="booruSourceLink.url"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ booruSourceLink.label }} <span aria-hidden="true">↗</span>
      </a>
    </div>

    <div class="post-info-rating">
      <span>Rating</span>
      <div class="safety-buttons">
        <button
          class="safety-btn safe"
          :class="{ active: post.safety === 'safe' }"
          @click="setSafety('safe')"
          title="Safe"
        ></button>
        <button
          class="safety-btn sketchy"
          :class="{ active: post.safety === 'sketchy' }"
          @click="setSafety('sketchy')"
          title="Sketchy"
        ></button>
        <button
          class="safety-btn unsafe"
          :class="{ active: post.safety === 'unsafe' }"
          @click="setSafety('unsafe')"
          title="Unsafe"
        ></button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { pixivArtworkUrlFromPost } from '../../utils/sourceLinks'
import {
  booruSourceLinkFromPost,
  formatFileSize,
  formatFullDate,
  formatRelativeDate,
  tweetIdFromPost,
} from '../../composables/usePostPageFormat'

const props = defineProps({
  post: {
    type: Object,
    required: true,
  },
})
const emit = defineEmits(['set-safety'])

const tweetUrl = computed(() => {
  const id = tweetIdFromPost(props.post)
  return id ? `https://x.com/i/status/${id}` : ''
})
const pixivUrl = computed(() => pixivArtworkUrlFromPost(props.post))
const booruSourceLink = computed(() => booruSourceLinkFromPost(props.post))
function setSafety(safety) {
  emit('set-safety', safety)
}
</script>

<style scoped>
.post-info {
  display: grid;
  gap: 0.6rem;
}

.post-info-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.post-info-id {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

.post-info-id strong {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.post-info-type {
  padding: 0.12rem 0.45rem;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.post-info-date {
  color: var(--text-secondary);
  font-size: 0.78rem;
  white-space: nowrap;
}

.post-info-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-top: -0.3rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.post-info-dot {
  opacity: 0.6;
}

.post-info-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.post-info-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.22rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--accent);
  font-size: 0.75rem;
  font-weight: 600;
  text-decoration: none;
  transition: border-color 0.15s, background 0.15s;
}

.post-info-chip-logo {
  width: 0.8rem;
  height: 0.8rem;
  color: var(--text-primary);
}

.post-info-chip:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.post-info-rating {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.post-info-rating > span {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.safety-buttons {
  display: flex;
  gap: 0.35rem;
}

.safety-btn {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  opacity: 0.3;
  transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
}

.safety-btn:hover {
  transform: scale(1.1);
}

.safety-btn.active {
  opacity: 1;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.safety-btn.safe {
  background: #4ade80;
}

.safety-btn.sketchy {
  background: #facc15;
}

.safety-btn.unsafe {
  background: #f87171;
}

@media (max-width: 768px) {
  .safety-btn {
    width: 28px;
    height: 28px;
  }
}
</style>
