import { ref, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePostsStore } from '../stores/posts'

// The home grid's search state: query + safety filter + sort + pagination,
// kept in sync with the route and localStorage.

export const PER_PAGE_OPTIONS = [24, 42, 60, 100, 200, 500]
const DEFAULT_PER_PAGE = 42
const SAFETY_FILTER_KEY = 'safetyFilter'
const PER_PAGE_KEY = 'postsPerPage'

const defaultSafety = { safe: true, sketchy: true, unsafe: true }

// Load safety filter from localStorage or default to all enabled
function loadSafetyFilter() {
  try {
    const saved = localStorage.getItem(SAFETY_FILTER_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      // Validate it's an object with the expected properties
      if (typeof parsed === 'object' && 'safe' in parsed) {
        return parsed
      }
    }
  } catch (e) {
    // Invalid JSON, use default
  }
  return { ...defaultSafety }
}

function normalizePerPage(value) {
  const parsed = Number.parseInt(value, 10)
  return PER_PAGE_OPTIONS.includes(parsed) ? parsed : DEFAULT_PER_PAGE
}

function loadPerPage() {
  try {
    return normalizePerPage(localStorage.getItem(PER_PAGE_KEY) || DEFAULT_PER_PAGE)
  } catch {
    return DEFAULT_PER_PAGE
  }
}

export function usePostBrowser() {
  const route = useRoute()
  const router = useRouter()
  const postsStore = usePostsStore()

  const sortBy = ref('date')
  const sortOrder = ref('desc')
  const page = ref(1)
  const perPage = ref(loadPerPage())
  const safetyFilter = ref(loadSafetyFilter())

  const posts = ref([])
  const total = ref(0)
  const pages = ref(0)
  const loading = ref(false)
  const pendingScrollTop = ref(false)

  // The search in flight. A newer one aborts it, so a slow earlier search can
  // never land on top of newer results.
  let postsAbort = null

  async function fetchPosts() {
    postsAbort?.abort()
    const controller = new AbortController()
    postsAbort = controller
    loading.value = true
    try {
      // Build query with safety filter based on checkboxes
      let query = postsStore.query
      const { safe, sketchy, unsafe } = safetyFilter.value

      // Add exclusions for unchecked ratings
      const exclusions = []
      if (!safe) exclusions.push('-safety:safe')
      if (!sketchy) exclusions.push('-safety:sketchy')
      if (!unsafe) exclusions.push('-safety:unsafe')

      if (exclusions.length > 0) {
        query = query ? `${query} ${exclusions.join(' ')}` : exclusions.join(' ')
      }

      // Remember exactly what we're showing so the post view can step prev/next
      // through this same filtered, sorted set.
      postsStore.setBrowseContext({ query, sort: sortBy.value, order: sortOrder.value })

      const result = await fetch(
        `/api/posts?q=${encodeURIComponent(query)}&page=${page.value}&limit=${perPage.value}&sort=${sortBy.value}&order=${sortOrder.value}`,
        { signal: controller.signal }
      ).then(r => r.json())
      if (controller !== postsAbort) return

      posts.value = result.results
      total.value = result.total
      pages.value = result.pages
    } catch (e) {
      if (e?.name === 'AbortError') return
      console.error('Failed to fetch posts:', e)
    } finally {
      if (controller !== postsAbort) return
      loading.value = false
      if (pendingScrollTop.value) {
        pendingScrollTop.value = false
        await nextTick()
        scrollToTop()
      }
    }
  }

  // Seed the search state from the initial route (called on mount).
  function applyInitialRoute() {
    if (route.query.q) {
      postsStore.setQuery(route.query.q)
    }
    if (route.query.limit) {
      perPage.value = normalizePerPage(route.query.limit)
    }
    if (route.query.page) {
      page.value = parseInt(route.query.page) || 1
    }
  }

  function onSafetyChange() {
    localStorage.setItem(SAFETY_FILTER_KEY, JSON.stringify(safetyFilter.value))
    page.value = 1
    fetchPosts()
  }

  function onPerPageChange() {
    perPage.value = normalizePerPage(perPage.value)
    localStorage.setItem(PER_PAGE_KEY, String(perPage.value))
    page.value = 1
    const query = {
      ...route.query,
      page: undefined,
      limit: perPage.value === DEFAULT_PER_PAGE ? undefined : perPage.value,
    }
    const routeWillChange =
      String(route.query.page || '') !== String(query.page || '') ||
      String(route.query.limit || '') !== String(query.limit || '')

    requestScrollToTop()
    router.push({ query })
    if (!routeWillChange) fetchPosts()
  }

  function onPageChange(newPage) {
    page.value = newPage
    requestScrollToTop()
    router.push({
      query: {
        ...route.query,
        page: newPage > 1 ? newPage : undefined,
        limit: perPage.value === DEFAULT_PER_PAGE ? undefined : perPage.value,
      }
    })
  }

  function requestScrollToTop() {
    pendingScrollTop.value = true
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }

  function updateLocalPost(postId, data) {
    const index = posts.value.findIndex((post) => post.id === postId)
    if (index === -1) return
    posts.value[index] = {
      ...posts.value[index],
      ...data,
    }
  }

  watch(
    () => route.query,
    (newQuery) => {
      if (newQuery.q !== postsStore.query) {
        postsStore.setQuery(newQuery.q || '')
      }
      if (newQuery.page) {
        page.value = parseInt(newQuery.page) || 1
      } else {
        page.value = 1
      }
      if (newQuery.limit) {
        perPage.value = normalizePerPage(newQuery.limit)
      }
      fetchPosts()
    }
  )

  return {
    sortBy,
    sortOrder,
    page,
    perPage,
    perPageOptions: PER_PAGE_OPTIONS,
    safetyFilter,
    posts,
    total,
    pages,
    loading,
    fetchPosts,
    applyInitialRoute,
    onSafetyChange,
    onPerPageChange,
    onPageChange,
    updateLocalPost,
  }
}
