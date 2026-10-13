<template>
  <BatchCard
    title="Tags & Rating"
    description="Add, remove, replace, clear tags, or set safety across selected posts."
  >
    <div class="batch-field-grid compact">
      <label>
        Tag operation
        <select v-model="batchTagMode">
          <option value="add">Add tags</option>
          <option value="remove">Remove tags</option>
          <option value="replace">Replace all tags</option>
          <option value="clear">Clear all tags</option>
        </select>
      </label>
      <label>
        Safety
        <select v-model="batchSafety">
          <option value="">No change</option>
          <option value="safe">Safe</option>
          <option value="sketchy">Sketchy</option>
          <option value="unsafe">Unsafe / NSFW</option>
        </select>
      </label>
    </div>
    <!-- The same tag box as Edit Tags: autocomplete, and multi-word tags
         like "call of the night" stay one tag instead of splitting on spaces. -->
    <div v-if="batchTagMode !== 'clear'" class="batch-textarea-label">
      Tags
      <TagInput v-model="batchTags" placeholder="Type a tag, then Enter or comma..." />
    </div>
    <div class="batch-actions-row">
      <button type="button" class="btn btn-secondary" :disabled="!selectedCount || busy" @click="applyBatchTagUpdate">
        Apply Tag / Rating Changes
      </button>
      <button type="button" class="btn btn-danger" :disabled="!selectedCount || busy" @click="clearTagsSelected">
        Clear Tags
      </button>
    </div>
  </BatchCard>
</template>

<script setup>
import BatchCard from './BatchCard.vue'
import TagInput from '../TagInput.vue'

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

const { batchTagMode, batchTags, batchSafety, applyBatchTagUpdate, clearTagsSelected } = props.edits
</script>

<style scoped src="./batchForms.css"></style>
