<template>
  <PostPageFrame
    v-if="post"
    :src="media.src"
    :alt="`${siteLabel} #${post.id}`"
    :type="media.type"
    :no-referrer="noReferrer"
    :wide-frame="wideFrame"
    :sidebar-hidden="sidebarHidden"
    :zoom-animation="zoomAnimation"
    :has-prev="Boolean(prevPost)"
    :has-next="Boolean(nextPost)"
    @close="handleClose"
    @prev="goTo(prevPost)"
    @next="goTo(nextPost)"
    @toggle-zoom-animation="toggleZoomAnimation"
    @toggle-wide-frame="toggleWideFrame"
    @toggle-sidebar-hidden="toggleSidebarHidden"
  >
    <template #sidebar>
      <PostInfoSection :post="infoPost" :links="infoLinks" readonly-rating />

      <div class="sidebar-section actions booru-actions">
        <router-link
          v-if="libraryPostId"
          class="btn booru-library-link"
          :to="`/post/${libraryPostId}`"
        >View in library</router-link>
        <button
          v-else
          type="button"
          class="btn booru-import"
          :disabled="!post.fileUrl || importing"
          :title="post.fileUrl ? 'Import this post into NekoBooru' : 'The booru does not offer the original file'"
          @click="importPost"
        >{{ importing ? 'Importing…' : 'Import to NekoBooru' }}</button>
        <a
          class="btn btn-secondary booru-site-link"
          :href="post.postUrl"
          target="_blank"
          rel="noopener noreferrer"
        >Open on {{ siteLabel }}</a>
        <p v-if="status" class="booru-status" :class="`booru-status-${status.kind}`" role="status">{{ status.text }}</p>
        <p v-else-if="post.unavailable" class="booru-status">{{ unavailableText }}</p>
      </div>

      <div class="sidebar-section">
        <h3>Tags</h3>
        <div :class="{ 'tag-scroll-box': tagDetails.length > TAG_SCROLL_THRESHOLD }">
          <TagSidebar :tags="tagDetails" />
        </div>
      </div>
    </template>
  </PostPageFrame>
  <div v-else-if="loading" class="post-state post-loading">Loading...</div>
  <div v-else class="post-state booru-post-missing">
    <p>{{ errorText }}</p>
    <router-link class="btn btn-secondary" to="/">Back to the search</router-link>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api/client'
import TagSidebar from '../components/TagSidebar.vue'
import PostPageFrame from '../components/post/PostPageFrame.vue'
import PostInfoSection from '../components/post/PostInfoSection.vue'
import { useBooruPostImport } from '../composables/useBooruPostImport'
import { usePostFrameLayout } from '../composables/usePostFrameLayout'
import { booruSourceLinkFromPost, tweetIdFromPost } from '../composables/usePostPageFormat'
import { adapterFor } from '../remote/adapters/index.js'
import { imageReferrerPolicy, siteById } from '../remote/types.js'
import { useAuthStore } from '../stores/auth'
import { useBooruPostContextStore } from '../stores/booruPostContext'

// One booru post on the post page (route /booru/:site/:id): the native
// page's frame, info and tag sidebar with the booru's data, the library-only
// panels left out, and Import to NekoBooru / Open on <site> in their place.
// The post comes from the results page it was opened from (the
// booruPostContext store, which also drives Prev / Next); opened from its URL
// alone, it is fetched through the site's adapter and Prev / Next are hidden.
const TAG_SCROLL_THRESHOLD = 12
const UNAVAILABLE_TEXT = {
  hidden: 'The booru shows the original only to logged-in users.',
  deleted: 'This post was deleted on the booru.',
  banned: 'This post is banned on the booru.',
  'no-file': 'The booru offers no original file for this post.',
}

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const context = useBooruPostContextStore()

const post = ref(null)
const loading = ref(true)
const errorText = ref('')
const categoryColors = ref({})
let loadAbort = null

const { wideFrame, sidebarHidden, zoomAnimation, toggleWideFrame, toggleZoomAnimation, toggleSidebarHidden } = usePostFrameLayout()
const { libraryPostId, importing, status, importPost } = useBooruPostImport({ post, context })

const siteLabel = computed(() => siteById(post.value?.site || route.params.site)?.label || String(route.params.site || 'booru'))
const noReferrer = computed(() => imageReferrerPolicy(post.value?.site) === 'no-referrer')
const unavailableText = computed(() => UNAVAILABLE_TEXT[post.value?.unavailable] || '')

// Videos play from the original (ugoira zips cannot); everything else shows
// the original image, else the sample, else the grid preview.
const media = computed(() => {
  const current = post.value
  // displayFileUrl: the original as the browser may load it (Gelbooru's goes
  // through the backend relay); fileUrl is what an import downloads.
  const shown = current.displayFileUrl || current.fileUrl
  if (current.mediaType === 'video' && shown && current.fileExt !== 'zip') return { src: shown, type: 'video' }
  const original = current.mediaType === 'video' ? null : shown
  return { src: original || current.sampleUrl || current.thumbUrl || '', type: current.mediaType === 'gif' && original ? 'gif' : 'image' }
})

// The shape PostInfoSection reads from a library post.
const infoPost = computed(() => {
  const current = post.value
  return {
    id: current.id,
    extension: current.fileExt ? `.${current.fileExt}` : '',
    createdAt: current.createdAt || undefined,
    width: current.width ?? '?',
    height: current.height ?? '?',
    fileSize: current.fileSize ?? null,
    safety: current.safety,
    tags: current.tags || [],
    source: current.source || '',
  }
})

// The post's own source when PostInfoSection has no chip for it.
const infoLinks = computed(() => {
  const source = infoPost.value.source
  if (!/^https?:\/\//i.test(source) || tweetIdFromPost(infoPost.value) || booruSourceLinkFromPost(infoPost.value)) return []
  try {
    return [{ url: source, label: new URL(source).hostname.replace(/^www\./, '') }]
  } catch {
    return []
  }
})

const tagDetails = computed(() => {
  const current = post.value
  const categories = current.tagCategories || {}
  const names = current.tagDisplayNames || {}
  return (current.tags || []).map((name) => {
    const category = categories[name] || 'general'
    return { name, category, displayName: names[name] || '', categoryColor: categoryColors.value[category] || '' }
  })
})

const neighbours = computed(() => (post.value ? context.neighbours(post.value.key) : { prev: null, next: null }))
const prevPost = computed(() => neighbours.value.prev)
const nextPost = computed(() => neighbours.value.next)

function goTo(target) {
  if (target) router.push({ name: 'booru-post', params: { site: target.site, id: target.id } })
}

async function loadPost() {
  loadAbort?.abort()
  const { site, id } = route.params
  errorText.value = ''
  const known = context.postFor(site, id)
  if (known) {
    post.value = known
    loading.value = false
    return
  }
  post.value = null
  const adapter = adapterFor(site)
  if (!adapter) {
    errorText.value = `"${site}" is not a booru NekoBooru searches.`
    loading.value = false
    return
  }
  if (typeof adapter.getPost !== 'function') {
    errorText.value = `${siteLabel.value} posts cannot be opened from a link. Open this one from the booru search on the home page.`
    loading.value = false
    return
  }
  const controller = new AbortController()
  loadAbort = controller
  loading.value = true
  try {
    const fetched = await adapter.getPost(id, { api, signal: controller.signal })
    if (!controller.signal.aborted) post.value = fetched
  } catch (error) {
    if (controller.signal.aborted) return
    errorText.value = `${siteLabel.value} post #${id} could not be loaded: ${error?.message || error}`
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}

async function loadCategoryColors() {
  try {
    const rows = await api.getCategories()
    categoryColors.value = Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.name, row.color]))
  } catch {
    // TagSidebar falls back to its default colour.
  }
}

function handleClose() {
  if (window.history.state?.back) router.back()
  else router.push('/')
}

function onKeydown(event) {
  const target = event.target
  const tag = target?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'ArrowLeft' && prevPost.value) {
    event.preventDefault()
    goTo(prevPost.value)
  } else if (event.key === 'ArrowRight' && nextPost.value) {
    event.preventDefault()
    goTo(nextPost.value)
  }
}

// Booru search is per user; leave if it is switched off while here.
watch(() => auth.canBrowseBoorus, (allowed) => {
  if (!allowed) router.replace({ name: 'home' })
})

watch(() => [route.params.site, route.params.id], () => {
  if (route.name === 'booru-post') loadPost()
})

onMounted(() => {
  loadPost()
  loadCategoryColors()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  loadAbort?.abort()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped src="../components/post/postSidebar.css"></style>

<style scoped>
.booru-actions .btn {
  text-align: center;
  text-decoration: none;
}

.booru-status {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.booru-status-success {
  color: var(--success);
}

.booru-status-error {
  color: var(--coral);
}

.booru-post-missing {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}
</style>
