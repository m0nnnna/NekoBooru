<template>
  <BatchCard
    title="Organize & Cleanup"
    description="Pool selected posts or remove bad imports."
    :open="false"
  >
    <div class="batch-actions-row">
      <button type="button" class="btn btn-secondary" :disabled="!selectedCount || busy" @click="$emit('add-to-pool')">
        Add to pool
      </button>
      <button type="button" class="btn btn-danger" :disabled="!selectedCount || busy" @click="$emit('delete')">
        Delete selected
      </button>
    </div>
  </BatchCard>
</template>

<script setup>
import BatchCard from './BatchCard.vue'

defineProps({
  selectedCount: {
    type: Number,
    default: 0,
  },
  busy: {
    type: Boolean,
    default: false,
  },
})

defineEmits(['add-to-pool', 'delete'])
</script>

<style scoped src="./batchForms.css"></style>
