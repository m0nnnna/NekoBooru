import { computed, onUnmounted, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { useBooruPostContextStore } from '../stores/booruPostContext'
import { usePostsStore } from '../stores/posts'
import { useRemoteSourcesStore } from '../stores/remoteSources'
import { useRemoteResults } from '../remote/useRemoteResults.js'
import { LIBRARY_SOURCE, SITES, idTagFor, libraryKey, makeKey } from '../remote/types.js'

// The home view's booru search wiring (sections 4.2 and 4.5 of
// docs/booru-search-plan.md): which sources are ticked, the remote search
// that follows the library's query/rating/sort/page-size, the grid entries the
// selection walks, and opening a post on the booru post page. With booru search off for this
// user (`canBrowseBoorus` false) or nothing remote ticked, `remoteActive` is
// false and the home view renders exactly what it always has.

// '<site>_<id>' as the library stores it (lower-cased, so Sankaku's mixed-case
// ids only match through idTagFor()).
const ID_TAG = new RegExp(`^(${SITES.map((site) => site.id).join('|')})_([a-z0-9_-]+)$`)

/**
 * useHomeBooruSearch({ browser, results })
 * `browser` is usePostBrowser()'s return; `results` defaults to a fresh
 * useRemoteResults({ api }). Call start() once the browser has read the route.
 */
export function useHomeBooruSearch({ browser, results = useRemoteResults({ api }) }) {
  const auth = useAuthStore()
  const store = useRemoteSourcesStore()
  const postsStore = usePostsStore()
  const route = useRoute()
  const router = useRouter()
  const postContext = useBooruPostContextStore()

  const enabled = computed(() => auth.canBrowseBoorus)
  const remoteActive = computed(() => enabled.value && store.remoteSites.length > 0)
  const libraryShown = computed(() => !enabled.value || store.libraryTicked)
  const layout = computed(() => (remoteActive.value && store.layout === 'interleaved' ? 'interleaved' : 'grouped'))
  let started = false

  // Booru id tags on the library page -> the library post carrying them.
  const libraryIdTags = computed(() => {
    const found = new Map()
    if (!remoteActive.value || !libraryShown.value) return found
    for (const post of browser.posts.value || []) {
      for (const tag of post.tags || []) {
        const name = String(tag ?? '').toLowerCase()
        if (ID_TAG.test(name) && !found.has(name)) found.set(name, post.id)
      }
    }
    return found
  })

  // The keys those tags name, for the results composable's own hiding.
  function hiddenKeys() {
    const keys = new Set()
    for (const name of libraryIdTags.value.keys()) {
      const [, site, id] = name.match(ID_TAG)
      keys.add(makeKey(site, id))
    }
    return keys
  }

  // Interleaved feed minus remote duplicates of library posts on this page.
  const feed = computed(() => {
    const posts = results.interleaved.value
    const tags = libraryIdTags.value
    return tags.size ? posts.filter((post) => !tags.has(idTagFor(post))) : posts
  })

  function inLibraryPostId(post) {
    if (!post) return null
    return results.inLibrary.get(post.key)?.postId ?? libraryIdTags.value.get(idTagFor(post)) ?? null
  }

  // Grid order for the selection: library page first, then each section (or
  // the interleaved feed, one group so a shift-range follows the grid).
  const entries = computed(() => {
    const list = []
    const mixed = layout.value === 'interleaved'
    if (libraryShown.value) {
      for (const post of browser.posts.value || []) {
        list.push({ key: libraryKey(post.id), group: mixed ? 'feed' : LIBRARY_SOURCE, item: post })
      }
    }
    if (!remoteActive.value) return list
    if (mixed) {
      for (const post of feed.value) list.push({ key: post.key, group: 'feed', item: post })
      return list
    }
    for (const site of results.order.value) {
      for (const post of results.sections[site]?.posts || []) list.push({ key: post.key, group: site, item: post })
    }
    return list
  })

  function searchArgs() {
    return {
      query: postsStore.query,
      options: {
        safety: { ...browser.safetyFilter.value },
        sort: browser.sortBy.value,
        order: browser.sortOrder.value,
      },
      sites: [...store.sources],
      hiddenKeys: hiddenKeys(),
      limit: browser.remoteLimit.value,
      siteSafety: JSON.parse(JSON.stringify(store.ratings)),
    }
  }

  function stopRemote() {
    results.cancelScheduledSearch()
    if (results.order.value.length) results.search({ sites: [] })
  }

  // Changing the query, a rating checkbox, the sort, the page size or a tick
  // re-searches after the composable's 500 ms debounce.
  watch(
    () => [
      remoteActive.value,
      postsStore.query,
      JSON.stringify(browser.safetyFilter.value),
      browser.sortBy.value,
      browser.sortOrder.value,
      store.sources.join(','),
      browser.remoteLimit.value,
      JSON.stringify(store.ratings),
    ],
    () => {
      if (!started) return
      if (!remoteActive.value) return stopRemote()
      results.scheduleSearch(searchArgs())
    },
  )

  // Back/forward onto a URL with other ?sources/?layout/?ratings: follow it.
  watch(
    () => [route.query.sources, route.query.layout, route.query.ratings],
    () => {
      if (!started || !enabled.value || route.name !== 'home') return
      const wanted = store.toRouteQuery()
      if (['sources', 'layout', 'ratings'].every((key) => (route.query[key] ?? undefined) === wanted[key])) return
      store.fromRoute(route.query)
    },
  )

  // Booru search may be switched on for this user after the view mounted.
  watch(enabled, (on) => {
    if (on && started) begin()
    else if (!on) stopRemote()
  })

  function begin() {
    store.fromRoute(route.query)
    if (remoteActive.value) results.search(searchArgs())
  }

  // Called by the home view after usePostBrowser has read the route.
  function start() {
    started = true
    if (enabled.value) begin()
  }

  // --- The booru post page (route booru-post) ---
  // A booru post opens on the post page, which gets the posts of the section
  // (or the interleaved feed) it was opened from for its Prev / Next.
  function openPost(key) {
    const post = results.postByKey(key)
    if (!post) return
    const list = layout.value === 'interleaved' ? feed.value : results.sections[post.site]?.posts || []
    postContext.open(list.some((entry) => entry.key === key) ? list : [post], inLibraryPostId)
    router.push({ name: 'booru-post', params: { site: post.site, id: post.id } })
  }

  // --- Posts imported from a booru (4.4) ---
  // An imported post is usually not on the current library page; the batch
  // tools resolve selected library posts through libraryPostById().
  const importedPosts = reactive(new Map())

  function libraryPostById(id) {
    return (browser.posts.value || []).find((post) => post.id === id) || importedPosts.get(id) || null
  }

  // The batch tools' updateLocalPost: patch the page post and the imported
  // one, so the next edit (or the per-post fallback) starts from current tags.
  function updateLibraryPost(postId, data) {
    browser.updateLocalPost(postId, data)
    const imported = importedPosts.get(postId)
    if (imported) importedPosts.set(postId, { ...imported, ...data })
  }

  // `prepend`: a newly created post, shown at the top of page 1 of a
  // newest-first library listing so the user sees it arrive.
  function rememberLibraryPost(post, { prepend = false } = {}) {
    const id = Number(post?.id)
    if (!id) return
    importedPosts.set(id, post)
    const posts = browser.posts.value || []
    const newestFirst = browser.sortBy.value === 'date' && browser.sortOrder.value === 'desc' && browser.page.value === 1
    if (prepend && libraryShown.value && newestFirst && !posts.some((entry) => entry.id === id)) {
      browser.posts.value = [post, ...posts]
    }
  }

  const resultCountLabel = computed(() => {
    if (libraryShown.value) return `${browser.total.value} posts found`
    const count = results.order.value.reduce((sum, site) => sum + (results.sections[site]?.posts.length || 0), 0)
    return `${count} booru posts loaded`
  })

  onUnmounted(() => results.dispose())

  // One reactive object for the template and the remote components.
  return reactive({
    results,
    enabled,
    remoteActive,
    libraryShown,
    layout,
    sections: results.sections,
    order: results.order,
    feed,
    anyLoading: results.anyLoading,
    entries,
    resultCountLabel,
    inLibraryPostId,
    goToPage: (site, page) => results.goToPage(site, page),
    retry: (site) => results.retry(site),
    postByKey: (key) => results.postByKey(key),
    markImported: (key, postId) => results.markImported(key, postId),
    importedPosts,
    libraryPostById,
    rememberLibraryPost,
    updateLibraryPost,
    openPost,
    start,
  })
}
