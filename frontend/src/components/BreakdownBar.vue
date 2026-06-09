<template>
  <div class="breakdown">
    <div class="breakdown-track">
      <div
        v-for="(item, idx) in positive"
        :key="idx"
        class="breakdown-seg"
        :style="{ width: pct(item) + '%', background: item.color }"
        :title="`${item.label}: ${item.value}`"
      ></div>
    </div>
    <ul class="breakdown-legend">
      <li v-for="(item, idx) in items" :key="idx">
        <span class="dot" :style="{ background: item.color }"></span>
        {{ item.label }} <b>{{ item.value }}</b>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  items: { type: Array, default: () => [] },
})

const total = computed(() => props.items.reduce((s, i) => s + i.value, 0) || 1)
const positive = computed(() => props.items.filter((i) => i.value > 0))
function pct(item) {
  return (item.value / total.value) * 100
}
</script>

<style scoped>
.breakdown-track {
  display: flex;
  height: 16px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.breakdown-seg {
  height: 100%;
}

.breakdown-legend {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.breakdown-legend b {
  color: var(--text-primary);
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  margin-right: 0.4rem;
  vertical-align: middle;
}
</style>
