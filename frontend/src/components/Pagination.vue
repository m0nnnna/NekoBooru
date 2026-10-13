<template>
  <div class="pagination" v-if="visible">
    <button
      class="btn btn-secondary"
      :disabled="disabled || modelValue <= 1"
      @click="go(modelValue - 1)"
    >
      &#x276E; Prev
    </button>
    <div class="page-info">
      &#x1F43E; Page
      <input
        v-if="jumpable"
        class="page-jump"
        type="number"
        min="1"
        :max="pages"
        :value="modelValue"
        :disabled="disabled"
        aria-label="Go to page"
        @change="jumpTo($event.target)"
        @keydown.enter.prevent="jumpTo($event.target)"
      />
      <template v-else>{{ format(modelValue) }}</template>
      <template v-if="pagesKnown"> of {{ estimate ? '~' : '' }}{{ format(pages) }}</template>
      &#x1F43E;
    </div>
    <button
      class="btn btn-secondary"
      :disabled="disabled || !canNext"
      @click="go(modelValue + 1)"
    >
      Next &#x276F;
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

// Prev / "Page N of M" / Next. The library passes modelValue and pages only.
// Booru sections add: `pages: null` when the count is unknown, `hasNext` when
// the next page's existence is known apart from the count, `estimate` for a
// "~" count, `jump` for a page-number box (numbered paging only) and
// `disabled` while a page loads.
const props = defineProps({
  modelValue: {
    type: Number,
    required: true,
  },
  pages: {
    type: Number,
    default: null,
  },
  hasNext: {
    type: Boolean,
    default: null,
  },
  estimate: {
    type: Boolean,
    default: false,
  },
  jump: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:modelValue'])

const pagesKnown = computed(() => Number.isFinite(props.pages) && props.pages > 0)
const canNext = computed(() => (props.hasNext === null ? props.modelValue < props.pages : props.hasNext))
// The library pager stays up on a single page ("Page 1 of 1", both buttons
// disabled) so the layout doesn't shift between searches; it hides only when
// nothing was found.
const visible = computed(() => (props.hasNext === null
  ? props.pages >= 1
  : props.modelValue > 1 || props.hasNext || props.pages > 1))
const jumpable = computed(() => props.jump && pagesKnown.value && props.pages > 1)

function format(value) {
  return Number(value).toLocaleString('en-US')
}

function go(page) {
  if (page !== props.modelValue) emit('update:modelValue', page)
}

function jumpTo(input) {
  const page = Math.floor(Number(input.value))
  if (!Number.isFinite(page)) {
    input.value = props.modelValue
    return
  }
  const clamped = Math.min(Math.max(1, page), props.pages)
  input.value = clamped
  go(clamped)
}
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

/* The global .btn has no disabled look; grey Prev/Next out here so page 1 of
   1 (and the ends of a range) read as unavailable. */
.pagination .btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

.page-jump {
  width: 5.5rem;
  padding: 0.25rem 0.4rem;
  text-align: center;
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
