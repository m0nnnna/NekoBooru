<template>
  <div class="post-grid" :class="{ 'is-loading': loading && posts.length > 0 }">
    <PostCard
      v-for="post in posts"
      :key="post.id"
      :post="post"
      @click="$emit('select', post)"
    />
    <div v-if="posts.length === 0 && !loading" class="empty-state">
      No posts found
    </div>
    <div v-if="loading && posts.length === 0" class="loading-state">
      Loading...
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
}
</style>
