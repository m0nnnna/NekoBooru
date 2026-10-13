<template>
  <div v-if="showTagEditor" class="modal-overlay" @click.self="showTagEditor = false">
    <div class="modal modal-split">
      <h2>Edit Tags</h2>
      <div class="modal-body">
        <div class="tag-editor-toolbar">
          <div class="segmented-control" aria-label="Tag editor mode">
            <button
              type="button"
              :class="{ active: tagEditorMode === 'visual' }"
              @click="setTagEditorMode('visual')"
            >
              Pills
            </button>
            <button
              type="button"
              :class="{ active: tagEditorMode === 'raw' }"
              @click="setTagEditorMode('raw')"
            >
              Text
            </button>
          </div>
          <div class="tag-editor-tools">
            <span class="tag-editor-count">{{ editedTags.length }} tags</span>
            <button type="button" class="btn btn-secondary clear-tags-btn" @click="clearEditedTags">
              Clear Tags
            </button>
          </div>
        </div>
        <TagInput v-if="tagEditorMode === 'visual'" v-model="editedTags" />
        <div v-else class="raw-tag-editor">
          <textarea
            ref="rawTagTextarea"
            v-model="rawEditedTags"
            spellcheck="false"
            placeholder="One tag per line, comma-separated tags, or a JSON array..."
            @input="onRawTagInput"
            @keydown.down.prevent="onRawTagArrowDown"
            @keydown.up.prevent="onRawTagArrowUp"
            @keydown.enter="onRawTagEnter"
            @keydown.esc="hideRawTagSuggestions"
            @blur="onRawTagBlur"
          ></textarea>
          <ul v-if="rawTagSuggestions.length > 0" class="raw-tag-suggestions">
            <li
              v-for="(tag, index) in rawTagSuggestions"
              :key="tag.name"
              :class="{ selected: index === rawTagSelectedIndex }"
              :style="{ borderLeftColor: tag.categoryColor }"
              @mousedown.prevent="selectRawTagSuggestion(tag)"
              @mouseenter="rawTagSelectedIndex = index"
            >
              <span class="tag-name">{{ tag.name }}</span>
              <span class="tag-count">{{ tag.usageCount }}</span>
            </li>
          </ul>
          <p class="raw-tag-hint">
            Accepts JSON arrays, {"tags": [...]}, commas, new lines, or spaces. Tags are normalized to lowercase underscores.
          </p>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" @click="showTagEditor = false">Cancel</button>
        <button class="btn" @click="saveTags">Save</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import TagInput from '../TagInput.vue'

const props = defineProps({
  // The object returned by usePostPageTagEditor().
  editor: {
    type: Object,
    required: true,
  },
})

const {
  showTagEditor,
  tagEditorMode,
  editedTags,
  rawEditedTags,
  rawTagTextarea,
  rawTagSuggestions,
  rawTagSelectedIndex,
  setTagEditorMode,
  clearEditedTags,
  onRawTagInput,
  onRawTagArrowDown,
  onRawTagArrowUp,
  onRawTagEnter,
  hideRawTagSuggestions,
  onRawTagBlur,
  selectRawTagSuggestion,
  saveTags,
} = props.editor
</script>

<style scoped src="./postModal.css"></style>

<style scoped>
.tag-editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.segmented-control {
  display: inline-flex;
  padding: 0.2rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.segmented-control button {
  min-width: 4rem;
  padding: 0.4rem 0.7rem;
  border: 0;
  border-radius: 0.35rem;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-weight: 600;
}

.segmented-control button.active {
  background: var(--accent);
  color: #fff;
}

.tag-editor-count {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.tag-editor-tools {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.clear-tags-btn {
  padding: 0.4rem 0.7rem;
  font-size: 0.82rem;
}

.raw-tag-editor textarea {
  width: 100%;
  min-height: 260px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  padding: 0.75rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 0.9rem;
  line-height: 1.45;
}

.raw-tag-editor textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.raw-tag-suggestions {
  margin: 0.4rem 0 0;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  box-shadow: 0 4px 12px var(--shadow);
}

.raw-tag-suggestions li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid transparent;
  color: var(--text-primary);
  cursor: pointer;
}

.raw-tag-suggestions li:hover,
.raw-tag-suggestions li.selected {
  background: var(--bg-tertiary);
}

.raw-tag-hint {
  margin: 0.5rem 0 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

</style>
