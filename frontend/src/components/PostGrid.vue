<template>
  <div class="post-grid" :class="{ 'is-loading': loading && posts.length > 0 }">
    <PostCard
      v-for="post in posts"
      :key="post.id"
      :post="post"
      @click="$emit('select', post)"
    />
    <div v-if="posts.length === 0 && !loading" class="empty-state">
      <div class="neko-face">(=^&#xB7;&#x2D8;&#xB7;^=)</div>
      <div>No posts found, nyaa~</div>
    </div>
    <div v-if="loading && posts.length === 0" class="loading-state">
      <div class="neko-loading">
        <span>&#x1F43E;</span><span>&#x1F43E;</span><span>&#x1F43E;</span>
      </div>
      <div>Fetching posts...</div>
    </div>
  </div>
</template>

<script setup>
import PostCard from './PostCard.vue'

defineProps({
  posts: {
    type: Array,
    required: true,
  },
  loading: {
    type: Boolean,
    default: false,
  },
})

defineEmits(['select'])
</script>

<style scoped>
.post-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.75rem;
  transition: opacity 0.15s;
}

.post-grid.is-loading {
  opacity: 0.6;
  pointer-events: none;
}

.empty-state,
.loading-state {
  grid-column: 1 / -1;
  text-align: center;
  padding: 3rem;
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.neko-face {
  font-size: 2rem;
  color: var(--text-muted);
  user-select: none;
}

.neko-loading {
  display: inline-flex;
  gap: 0.3rem;
  font-size: 1.4rem;
}

.neko-loading span {
  animation: nekoBounce 0.6s ease-in-out infinite;
}

.neko-loading span:nth-child(2) {
  animation-delay: 0.15s;
}

.neko-loading span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes nekoBounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

@media (max-width: 768px) {
  .post-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.5rem;
  }

  .empty-state,
  .loading-state {
    padding: 2rem;
  }
}

@media (max-width: 480px) {
  .post-grid {
    grid-template-columns: repeat(3, 1fr);
    gap: 0.35rem;
  }

  .empty-state,
  .loading-state {
    padding: 1.5rem;
    font-size: 0.9rem;
  }
}

@media (max-width: 360px) {
  .post-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
