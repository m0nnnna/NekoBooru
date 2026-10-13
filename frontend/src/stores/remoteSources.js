import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import router from '../router'
import { LIBRARY_SOURCE, SOURCE_IDS } from '../remote/types.js'

// Which sources the home search shows (the library and/or boorus) and how
// remote results are laid out (section 3.8 of docs/booru-search-plan.md).
// Kept in localStorage and mirrored into the URL (?sources=, ?layout=) with
// router.replace, so a link reproduces the view and Back does not step
// through every tick.

export const SOURCES_STORAGE_KEY = 'nekobooru.remoteSources'
export const LAYOUT_STORAGE_KEY = 'nekobooru.remoteLayout'
export const LAYOUTS = ['grouped', 'interleaved']
const DEFAULT_SOURCES = [LIBRARY_SOURCE]

// Known ids in SOURCE_IDS order, duplicates and unknowns dropped.
function normalizeSources(list) {
  const wanted = new Set((Array.isArray(list) ? list : []).map((id) => String(id ?? '').trim()))
  return SOURCE_IDS.filter((id) => wanted.has(id))
}

function sourcesFromParam(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  return normalizeSources(raw.split(','))
}

function loadSources() {
  try {
    const saved = normalizeSources(JSON.parse(localStorage.getItem(SOURCES_STORAGE_KEY) || '[]'))
    return saved.length ? saved : [...DEFAULT_SOURCES]
  } catch {
    return [...DEFAULT_SOURCES]
  }
}

function loadLayout() {
  try {
    return localStorage.getItem(LAYOUT_STORAGE_KEY) === 'interleaved' ? 'interleaved' : 'grouped'
  } catch {
    return 'grouped'
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage unavailable (private mode, blocked storage)
  }
}

export const useRemoteSourcesStore = defineStore('remoteSources', () => {
  const sources = ref(loadSources())
  const layout = ref(loadLayout())

  const libraryTicked = computed(() => sources.value.includes(LIBRARY_SOURCE))
  const remoteSites = computed(() => sources.value.filter((id) => id !== LIBRARY_SOURCE))

  function toRouteQuery() {
    const onlyLibrary = sources.value.length === 1 && sources.value[0] === LIBRARY_SOURCE
    return {
      sources: onlyLibrary ? undefined : sources.value.join(','),
      layout: layout.value === 'interleaved' ? 'interleaved' : undefined,
    }
  }

  // Bring the current route's query in line with the store, replacing (not
  // pushing) the history entry. Other query keys are kept as they are.
  function syncRoute() {
    const route = router.currentRoute.value
    const query = { ...route.query }
    const wanted = toRouteQuery()
    let changed = false
    for (const [key, value] of Object.entries(wanted)) {
      const present = Object.prototype.hasOwnProperty.call(query, key)
      if (value === undefined) {
        if (present) {
          delete query[key]
          changed = true
        }
      } else if (query[key] !== value) {
        query[key] = value
        changed = true
      }
    }
    if (!changed) return Promise.resolve()
    return Promise.resolve(router.replace({ query })).catch(() => {})
  }

  function commit(nextSources, nextLayout = layout.value) {
    sources.value = nextSources
    layout.value = nextLayout
    save(SOURCES_STORAGE_KEY, JSON.stringify(nextSources))
    save(LAYOUT_STORAGE_KEY, nextLayout)
    return syncRoute()
  }

  // Tick or untick one source. The last ticked source cannot be unticked.
  function toggle(sourceId) {
    if (!SOURCE_IDS.includes(sourceId)) return false
    const ticked = sources.value.includes(sourceId)
    if (ticked && sources.value.length === 1) return false
    const next = ticked
      ? sources.value.filter((id) => id !== sourceId)
      : normalizeSources([...sources.value, sourceId])
    commit(next)
    return true
  }

  function setSources(list) {
    const next = normalizeSources(list)
    if (!next.length) return false
    commit(next)
    return true
  }

  function setLayout(mode) {
    if (!LAYOUTS.includes(mode)) return false
    commit(sources.value, mode)
    return true
  }

  // Read ?sources=a,b and ?layout=interleaved. A parameter that is present
  // wins over storage; an absent one keeps what the store already has (so a
  // plain "/" keeps the saved ticks), and the URL is then brought in line.
  function fromRoute(query = {}) {
    let nextSources = sources.value
    let nextLayout = layout.value
    if (query.sources !== undefined && query.sources !== null) {
      const parsed = sourcesFromParam(query.sources)
      if (parsed.length) nextSources = parsed
    }
    if (query.layout !== undefined && query.layout !== null) {
      nextLayout = String(Array.isArray(query.layout) ? query.layout[0] : query.layout) === 'interleaved' ? 'interleaved' : 'grouped'
    }
    return commit(nextSources, nextLayout)
  }

  return {
    sources,
    layout,
    libraryTicked,
    remoteSites,
    toggle,
    setSources,
    setLayout,
    fromRoute,
    toRouteQuery,
    syncRoute,
  }
})
