<template>
  <div v-if="poolModalOpen" class="modal-overlay" @click.self="poolModalOpen = false">
    <div class="modal">
      <h3>Add {{ selectedCount }} post(s) to a pool</h3>
      <div class="pool-list">
        <label v-for="pool in pools" :key="pool.id" class="pool-option">
          <input type="radio" name="pool" :value="pool.id" v-model="chosenPoolId" />
          <span>{{ pool.name }} <small>({{ pool.postCount ?? (pool.posts ? pool.posts.length : 0) }})</small></span>
        </label>
        <label class="pool-option">
          <input type="radio" name="pool" value="__new__" v-model="chosenPoolId" />
          <span>Create new pool</span>
        </label>
        <input
          v-if="chosenPoolId === '__new__'"
          v-model="newPoolName"
          class="new-pool-input"
          type="text"
          placeholder="New pool name"
        />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" @click="poolModalOpen = false" :disabled="busy">Cancel</button>
        <button type="button" class="btn btn-primary" @click="confirmAddToPool" :disabled="busy || !canConfirmPool">
          Add
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by useBatchPostEdits().
  edits: {
    type: Object,
    required: true,
  },
  selectedCount: {
    type: Number,
    default: 0,
  },
  busy: {
    type: Boolean,
    default: false,
  },
})

const { poolModalOpen, pools, chosenPoolId, newPoolName, canConfirmPool, confirmAddToPool } = props.edits
</script>

<style scoped>
.pool-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}

.pool-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.pool-option small {
  color: var(--text-muted);
}

.new-pool-input {
  margin-top: 0.25rem;
  padding: 0.5rem;
  width: 100%;
}
</style>

<style scoped src="./batchModal.css"></style>
