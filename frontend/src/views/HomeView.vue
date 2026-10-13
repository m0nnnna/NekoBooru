<template>
  <div class="home-view">
    <div class="toolbar">
      <div class="result-count">
        <span :class="{ 'loading-fade': loading }">{{ booru.resultCountLabel }}</span>
      </div>
      <div class="toolbar-controls">
        <button
          type="button"
          class="btn select-toggle"
          :class="selectMode ? 'btn-primary' : 'btn-secondary'"
          @click="toggleSelectMode"
        >
          {{ selectMode ? 'Done' : 'Select' }}
        </button>
        <div class="safety-filter">
          <label
            class="safety-checkbox safe"
            :class="{ active: safetyFilter.safe }"
            title="Safe"
          >
            <input type="checkbox" v-model="safetyFilter.safe" @change="onSafetyChange" />
          </label>
          <label
            class="safety-checkbox sketchy"
            :class="{ active: safetyFilter.sketchy }"
            title="Sketchy"
          >
            <input type="checkbox" v-model="safetyFilter.sketchy" @change="onSafetyChange" />
          </label>
          <label
            class="safety-checkbox unsafe"
            :class="{ active: safetyFilter.unsafe }"
            title="Unsafe"
          >
            <input type="checkbox" v-model="safetyFilter.unsafe" @change="onSafetyChange" />
          </label>
        </div>
        <div class="sort-controls">
          <select v-model.number="perPageModel" @change="onPerPageChange" aria-label="Posts per page">
            <option v-for="option in perPageChoices" :key="option" :value="option">
              {{ option === PER_PAGE_DEFAULT ? 'Default' : option }} per page
            </option>
          </select>
          <select v-model="sortBy" @change="fetchPosts">
            <option value="date">Date</option>
            <option value="id">ID</option>
            <option value="size">Size</option>
          </select>
          <select v-model="sortOrder" @change="fetchPosts">
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>
      </div>
    </div>

    <BooruResults
      v-if="booru.remoteActive"
      :booru="booru"
      :library="{ posts, loading, page, pages, total }"
      :select-mode="selectMode"
      :selected-keys="selectedKeySet"
      :selected-library-ids="selectedLibraryIds"
      importable
      @page-change="onPageChange"
      @toggle="selection.toggle"
      @hold-select="selection.holdSelect"
      @hover-post="selection.hover"
      @library-toggle="onLibraryToggle"
      @library-hold="onLibraryHold"
      @library-hover="onLibraryHover"
      @import="importer.importFromViewer"
    />
    <template v-else>
      <Pagination
        v-model="page"
        :pages="pages"
        @update:modelValue="onPageChange"
      />

      <PostGrid
        :posts="posts"
        :loading="loading"
        :select-mode="selectMode"
        :selected-ids="selectedLibraryIds"
        @toggle="onLibraryToggle"
        @hold-select="onLibraryHold"
        @hover-post="onLibraryHover"
      />

      <Pagination
        v-model="page"
        :pages="pages"
        @update:modelValue="onPageChange"
      />
    </template>

    <BatchPanel
      v-if="selectMode"
      :dock="batchDock"
      :panel-style="batchPanelStyle"
      :selected-count="counts.total"
      :breakdown="booru.remoteActive || counts.remote ? counts : null"
      :busy="busy"
      :auto-job="batchAutoJob"
      :operation="batchOperation"
      @resize-start="startBatchResize"
      @set-dock="setBatchDock"
      @select-page="selectAllVisible"
      @clear="clearSelection"
      @delete="edits.deleteSelected"
      @done="toggleSelectMode"
      @cancel-job="cancelBatchAutoTag"
    >
      <template v-if="counts.remote > 0 || importer.queue.items.length" #remote>
        <ImportCard :queue="importer.importQueue" :selected-remote="selectedRemotePosts" />
      </template>
      <AiTagCard :ai="ai" :selected-count="selectedLibraryIds.length" :busy="busy" />
      <PostInspectorCard
        :post="inspectedLibraryPost"
        :remote-post="inspectedRemotePost"
        :semantic-analysis="inspectedSemanticAnalysis"
        :semantic-loading="inspectedSemanticLoading"
      />
      <BulkTagCard :edits="edits" :selected-count="selectedLibraryIds.length" :busy="busy" />
      <MediaOptimizeCard
        :optimizer="optimizer"
        :selected-count="selectedLibraryIds.length"
        :busy="busy"
        :compact="batchDock === 'right'"
      />
      <OrganizeCard
        :selected-count="selectedLibraryIds.length"
        :busy="busy"
        @add-to-pool="edits.openPoolModal"
        @delete="edits.deleteSelected"
      />
    </BatchPanel>

    <div v-if="actionMessage" class="action-toast" :class="actionMessageKind">
      {{ actionMessage }}
    </div>

    <AddToPoolModal :edits="edits" :selected-count="selectedLibraryIds.length" :busy="busy" />

    <MediaOptimizeDialogs :optimizer="optimizer" :busy="busy" />
  </div>
</template>

<script setup>
import { computed, onMounted, toRef } from 'vue'
import PostGrid from '../components/PostGrid.vue'
import Pagination from '../components/Pagination.vue'
import BooruResults from '../components/remote/BooruResults.vue'
import ImportCard from '../components/remote/ImportCard.vue'
import BatchPanel from '../components/batch/BatchPanel.vue'
import AiTagCard from '../components/batch/AiTagCard.vue'
import PostInspectorCard from '../components/batch/PostInspectorCard.vue'
import BulkTagCard from '../components/batch/BulkTagCard.vue'
import MediaOptimizeCard from '../components/batch/MediaOptimizeCard.vue'
import OrganizeCard from '../components/batch/OrganizeCard.vue'
import AddToPoolModal from '../components/batch/AddToPoolModal.vue'
import MediaOptimizeDialogs from '../components/batch/MediaOptimizeDialogs.vue'
import { PER_PAGE_DEFAULT, usePostBrowser } from '../composables/usePostBrowser'
import { useMixedSelection } from '../composables/useMixedSelection'
import { useHomeBooruSearch } from '../composables/useHomeBooruSearch'
import { useHomeImport } from '../composables/useHomeImport'
import { useBatchDock } from '../composables/useBatchDock'
import { useBatchOperations } from '../composables/useBatchOperations'
import { useBatchAiTagging } from '../composables/useBatchAiTagging'
import { useBatchPostEdits } from '../composables/useBatchPostEdits'
import { useBatchMediaOptimize } from '../composables/useBatchMediaOptimize'
import { usePostSemanticAnalysis } from '../composables/usePostSemanticAnalysis'
import { useAuthStore } from '../stores/auth'

const authStore = useAuthStore()
// Booru search (docs/booru-search-plan.md section 4) only exists for users
// with canBrowseBoorus; without it this view renders exactly as it always has.
const browser = usePostBrowser({ offerDefaultPerPage: computed(() => authStore.canBrowseBoorus) })
const {
  sortBy,
  sortOrder,
  page,
  perPageModel,
  perPageChoices,
  safetyFilter,
  posts,
  total,
  pages,
  loading,
  fetchPosts,
  onSafetyChange,
  onPerPageChange,
  onPageChange,
} = browser

const booru = useHomeBooruSearch({ browser })

// --- Multi-select editing mode ---
// String keys across library and booru cards ('nekobooru:42', 'danbooru:7').
// The batch tools get `librarySelection`: library ids and posts only, plus
// posts imported from a booru while selected (booru.libraryPostById).
const selection = useMixedSelection(toRef(booru, 'entries'), {
  postByKey: booru.postByKey,
  libraryPostById: booru.libraryPostById,
})
const {
  selectMode,
  selectedKeySet,
  selectedLibraryIds,
  selectedRemotePosts,
  counts,
  inspectedLibraryPost,
  inspectedRemotePost,
  librarySelection,
  toggleSelectMode,
  onLibraryToggle,
  onLibraryHold,
  onLibraryHover,
  selectAllVisible,
  clearSelection,
} = selection

const { batchDock, batchPanelStyle, setBatchDock, startBatchResize } = useBatchDock()

const operations = useBatchOperations({
  selectedCount: () => selectedLibraryIds.value.length,
  selectMode,
  fetchPosts,
})
const {
  busy,
  actionMessage,
  actionMessageKind,
  batchAutoJob,
  batchOperation,
  cancelBatchAutoTag,
} = operations

const ai = useBatchAiTagging({ selection: librarySelection, operations })
const edits = useBatchPostEdits({ selection: librarySelection, operations, browser })
const optimizer = useBatchMediaOptimize({ selection: librarySelection, operations, browser })
const { inspectedSemanticAnalysis, inspectedSemanticLoading } = usePostSemanticAnalysis(inspectedLibraryPost)

// Booru imports (Import card and the viewer's Import button), section 4.4.
const importer = useHomeImport({ booru, selection, showMessage: operations.showMessage })

onMounted(() => {
  browser.applyInitialRoute()
  booru.start()
  ai.loadBatchAiSettings()
  fetchPosts()
})
</script>

<style scoped>
.home-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.result-count {
  color: var(--text-secondary);
  min-width: 120px;
}

.loading-fade {
  opacity: 0.5;
}

.toolbar-controls {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.safety-filter {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.safety-checkbox {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.3;
  transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.safety-checkbox:hover {
  transform: scale(1.1);
}

.safety-checkbox.active {
  opacity: 1;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.safety-checkbox input {
  display: none;
}

.safety-checkbox.safe {
  background: #4ade80;
}

.safety-checkbox.sketchy {
  background: #facc15;
}

.safety-checkbox.unsafe {
  background: #f87171;
}

.sort-controls {
  display: flex;
  gap: 0.5rem;
}

.sort-controls select {
  padding: 0.5rem;
}

.select-toggle {
  white-space: nowrap;
}

.action-toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  padding: 0.75rem 1.25rem;
  border-radius: 0.5rem;
  color: white;
  box-shadow: 0 4px 16px var(--shadow);
  max-width: 90vw;
}

.action-toast.success {
  background: var(--success, #22c55e);
}

.action-toast.error {
  background: var(--coral, #f87171);
}

/* Mobile responsive styles */
@media (max-width: 768px) {
  .toolbar {
    gap: 0.75rem;
  }

  .toolbar-controls {
    width: 100%;
    justify-content: space-between;
  }

  .result-count {
    font-size: 0.875rem;
    min-width: auto;
  }

  .safety-checkbox {
    width: 32px;
    height: 32px;
    border-radius: 6px;
  }

  .sort-controls select {
    padding: 0.4rem;
    font-size: 0.85rem;
  }
}

@media (max-width: 480px) {
  .home-view {
    gap: 0.75rem;
  }

  .toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .result-count {
    text-align: center;
    font-size: 0.8rem;
  }

  .toolbar-controls {
    flex-direction: column;
    gap: 0.5rem;
  }

  .safety-filter {
    justify-content: center;
    gap: 0.5rem;
  }

  .safety-checkbox {
    width: 36px;
    height: 36px;
  }

  .sort-controls {
    width: 100%;
  }

  .sort-controls select {
    flex: 1;
  }
}
</style>
