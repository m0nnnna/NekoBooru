<template>
  <router-link :to="`/post/${post.id}`" class="post-card">
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
    </div>
  </router-link>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  post: {
    type: Object,
    required: true,
  },
})

const isVideo = computed(() => ['.webm', '.mp4'].includes(props.post.extension))
const isGif = computed(() => props.post.extension === '.gif')

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
}

.post-card:hover {
  transform: translateY(-4px) rotate(-0.5deg);
  box-shadow: 0 8px 24px var(--shadow);
  border-color: var(--accent);
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
