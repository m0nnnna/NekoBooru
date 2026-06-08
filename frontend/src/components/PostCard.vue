<template>
  <router-link
    :to="`/post/${post.id}`"
    class="post-card"
    :class="{ selectable: selectMode, selected }"
    @click="onClick"
  >
    <div class="thumb-container">
      <img
        :src="post.thumbUrl"
        :alt="post.filename"
        loading="lazy"
        @error="onImageError"
      />
      <div v-if="isVideo" class="badge video-badge">&#9658;</div>
      <div v-if="isGif" class="badge gif-badge">GIF</div>
      <div v-if="post.isFavorited" class="badge fav-badge">&#9829;</div>
      <div v-if="selectMode" class="select-check" :class="{ on: selected }" aria-hidden="true">
        <span v-if="selected">&#10003;</span>
      </div>
    </div>
  </router-link>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  post: {
    type: Object,
    required: true,
  },
  selectMode: {
    type: Boolean,
    default: false,
  },
  selected: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['toggle'])

const isVideo = computed(() => ['.webm', '.mp4'].includes(props.post.extension))
const isGif = computed(() => props.post.extension === '.gif')

function onClick(e) {
  // In select mode the card is a checkbox, not a link: swallow navigation and
  // toggle selection instead.
  if (props.selectMode) {
    e.preventDefault()
    emit('toggle', props.post.id)
  }
}

function onImageError(e) {
  // Try with a placeholder or show error state
  e.target.style.opacity = '0.5'
}
</script>

<style scoped>
.post-card {
  display: block;
  background: var(--bg-secondary);
  border-radius: 0.75rem;
  overflow: hidden;
  transition: transform 0.2s, box-shadow 0.2s;
  border: 2px solid transparent;
  content-visibility: auto;
  contain-intrinsic-size: 180px 180px;
}

.post-card:hover {
  transform: translateY(-4px) rotate(-0.5deg);
  box-shadow: 0 8px 24px var(--shadow);
  border-color: var(--accent);
}

.post-card.selectable:hover {
  transform: none;
}

.post-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}

.select-check {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid white;
  background: rgba(0, 0, 0, 0.45);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  font-weight: 700;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}

.select-check.on {
  background: var(--accent);
  border-color: white;
}

.thumb-container {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.thumb-container img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}

.post-card:hover .thumb-container img {
  transform: scale(1.05);
}

.badge {
  position: absolute;
  padding: 0.25rem 0.5rem;
  font-size: 0.7rem;
  font-weight: 700;
  border-radius: 0.25rem;
  text-transform: uppercase;
}

.video-badge {
  bottom: 0.5rem;
  right: 0.5rem;
  background: rgba(0, 0, 0, 0.75);
  color: white;
  backdrop-filter: blur(4px);
}

.gif-badge {
  bottom: 0.5rem;
  right: 0.5rem;
  background: var(--success);
  color: white;
}

.fav-badge {
  top: 0.5rem;
  right: 0.5rem;
  background: var(--coral);
  color: white;
  font-size: 0.875rem;
}
</style>
