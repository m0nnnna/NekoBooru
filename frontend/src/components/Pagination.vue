<template>
  <div class="pagination" v-if="pages > 1">
    <button
      class="btn btn-secondary"
      :disabled="modelValue <= 1"
      @click="$emit('update:modelValue', modelValue - 1)"
    >
      Prev
    </button>
    <div class="page-info">
      Page {{ modelValue }} of {{ pages }}
    </div>
    <button
      class="btn btn-secondary"
      :disabled="modelValue >= pages"
      @click="$emit('update:modelValue', modelValue + 1)"
    >
      Next
    </button>
  </div>
</template>

<script setup>
defineProps({
  modelValue: {
    type: Number,
    required: true,
  },
  pages: {
    type: Number,
    required: true,
  },
})

defineEmits(['update:modelValue'])
</script>

<style scoped>
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 1rem;
}

.page-info {
  color: var(--text-secondary);
}

@media (max-width: 480px) {
  .pagination {
    gap: 0.5rem;
    padding: 0.75rem;
  }

  .pagination .btn {
    padding: 0.6rem 1rem;
    min-height: 44px;
  }

  .page-info {
    font-size: 0.875rem;
  }
}
</style>
