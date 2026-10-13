<template>
  <div class="booru-results" :class="`layout-${booru.layout}`">
    <template v-if="booru.layout === 'grouped'">
      <section v-if="booru.libraryShown" class="library-section" aria-label="NekoBooru results">
        <header class="library-section-header">
          <h2>NekoBooru</h2>
          <span :class="{ 'loading-fade': library.loading }">· {{ library.total }} posts</span>
        </header>
        <Pagination :model-value="library.page" :pages="library.pages" @update:model-value="$emit('page-change', $event)" />
        <PostGrid
          :posts="library.posts"
          :loading="library.loading"
          :select-mode="selectMode"
          :selected-ids="selectedLibraryIds"
          @toggle="$emit('library-toggle', $event)"
          @hold-select="$emit('library-hold', $event)"
          @hover-post="$emit('library-hover', $event)"
        />
        <Pagination :model-value="library.page" :pages="library.pages" @update:model-value="$emit('page-change', $event)" />
      </section>

      <RemoteSection
        v-for="site in booru.order"
        :key="site"
        :site="site"
        :section="booru.sections[site]"
        :select-mode="selectMode"
        :selected-keys="selectedKeys"
        :in-library-post-id="booru.inLibraryPostId"
        @go-to-page="booru.goToPage"
        @retry="booru.retry"
        @toggle="$emit('toggle', $event)"
        @hold-select="$emit('hold-select', $event)"
        @hover-post="$emit('hover-post', $event)"
        @open="booru.openPost"
      />
    </template>

    <template v-else>
      <Pagination
        v-if="booru.libraryShown"
        :model-value="library.page"
        :pages="library.pages"
        @update:model-value="$emit('page-change', $event)"
      />

      <ul ref="strip" class="source-strip" aria-label="Sources">
        <li v-for="site in booru.order" :key="site" :class="{ failed: booru.sections[site].error }">
          <strong>{{ booru.sections[site].label }}</strong>
          <span>{{ countLabel(booru.sections[site]) }}</span>
          <span v-if="pageLabel(booru.sections[site])">· {{ pageLabel(booru.sections[site]) }}</span>
          <span v-if="waitingLabel(booru.sections[site])" class="waiting">· {{ waitingLabel(booru.sections[site]) }}</span>
          <span v-if="booru.sections[site].note" class="note">· {{ booru.sections[site].note }}</span>
          <span v-if="ignoredLabel(booru.sections[site])" class="note">· {{ ignoredLabel(booru.sections[site]) }}</span>
          <template v-if="booru.sections[site].error">
            <span class="error">· {{ errorLabel(booru.sections[site]) }}</span>
            <button type="button" class="btn btn-secondary btn-sm" @click="booru.retry(site)">Retry</button>
          </template>
        </li>
      </ul>

      <div class="remote-grid mixed-grid">
        <template v-if="booru.libraryShown">
          <PostCard
            v-for="post in library.posts"
            :key="`library-${post.id}`"
            :post="post"
            :select-mode="selectMode"
            :selected="selectedLibraryIds.includes(post.id)"
            @toggle="$emit('library-toggle', $event)"
            @hold-select="$emit('library-hold', $event)"
            @hover-post="$emit('library-hover', $event)"
          />
        </template>
        <RemotePostCard
          v-for="post in booru.feed"
          :key="post.key"
          :post="post"
          :select-mode="selectMode"
          :selected="selectedKeys.has(post.key)"
          :in-library-post-id="booru.inLibraryPostId(post)"
          @toggle="$emit('toggle', $event)"
          @hold-select="$emit('hold-select', $event)"
          @hover-post="$emit('hover-post', $event)"
          @open="booru.openPost"
        />
      </div>
      <p v-if="!booru.feed.length && !(booru.libraryShown && library.posts.length)" class="feed-empty">
        {{ booru.anyLoading ? 'Searching the boorus...' : 'No posts found, nyaa~' }}
      </p>

      <footer v-if="feedPage" class="feed-footer">
        <Pagination
          :model-value="feedPage"
          :has-next="feedHasNext"
          :disabled="booru.anyLoading"
          @update:model-value="stepFeed"
        />
      </footer>
    </template>

  </div>
</template>

<script setup>
import { computed, nextTick, ref } from 'vue'
import Pagination from '../Pagination.vue'
import PostCard from '../PostCard.vue'
import PostGrid from '../PostGrid.vue'
import RemotePostCard from './RemotePostCard.vue'
import RemoteSection from './RemoteSection.vue'
import { countLabel, errorLabel, ignoredLabel, pageLabel, waitingLabel } from '../../remote/sectionStatus.js'

// The home grid while booru sources are ticked (section 4.2 of
// docs/booru-search-plan.md). Grouped: the library block under a
// "NekoBooru" header, then one RemoteSection per booru. Interleaved: library
// paging on top, a per-source status strip, one mixed grid (library page
// first, then the boorus round-robin) and one Prev / Next that steps every
// source a page at a time (each source's own page shows in the strip).
// Library card events stay numeric (library-*); booru card events carry keys.
const props = defineProps({
  // useHomeBooruSearch()'s reactive return.
  booru: { type: Object, required: true },
  // { posts, loading, page, pages, total } of the library search.
  library: { type: Object, required: true },
  selectMode: { type: Boolean, default: false },
  selectedKeys: { type: Set, default: () => new Set() },
  selectedLibraryIds: { type: Array, default: () => [] },
})

defineEmits([
  'page-change',
  'toggle',
  'hold-select',
  'hover-post',
  'library-toggle',
  'library-hold',
  'library-hover',
])

const sectionList = computed(() => props.booru.order.map((site) => props.booru.sections[site]).filter(Boolean))
// The feed's page: the furthest any source has stepped to.
const feedPage = computed(() => Math.max(0, ...sectionList.value.map((section) => section.page || 0)))
const feedHasNext = computed(() => sectionList.value.some((section) => section.hasNext))
const strip = ref(null)

async function stepFeed(page) {
  props.booru.stepAll(page - feedPage.value)
  await nextTick()
  strip.value?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
}
</script>

<style scoped src="./remoteGrid.css"></style>

<style scoped>
.booru-results {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.library-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.library-section-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  color: var(--text-secondary);
}

.library-section-header h2 {
  font-size: 1.1rem;
  color: var(--text-primary);
}

.loading-fade {
  opacity: 0.5;
}

.source-strip {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.source-strip li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.source-strip strong {
  color: var(--text-primary);
}

.source-strip .note {
  color: var(--text-muted);
}

.source-strip .waiting {
  color: var(--warning);
}

.source-strip .error {
  color: var(--coral);
}

.feed-empty {
  text-align: center;
  padding: 2rem;
  color: var(--text-secondary);
}

.feed-footer {
  display: flex;
  justify-content: center;
}
</style>
