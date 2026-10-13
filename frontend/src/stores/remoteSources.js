import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import router from '../router'
import { LIBRARY_SOURCE, SAFETY_ORDER, SITES, SOURCE_IDS } from '../remote/types.js'

// Which sources the home search shows (the library and/or boorus), how
// remote results are laid out (section 3.8 of docs/booru-search-plan.md),
// and which ratings each booru may show on top of the global safety filter.
// Kept in localStorage and mirrored into the URL (?sources=, ?layout=,
// ?ratings=) with router.replace, so a link reproduces the view and Back does
// not step through every tick.

export const SOURCES_STORAGE_KEY = 'nekobooru.remoteSources'
export const LAYOUT_STORAGE_KEY = 'nekobooru.remoteLayout'
export const RATINGS_STORAGE_KEY = 'nekobooru.remoteRatings'
export const LAYOUTS = ['grouped', 'interleaved']
const RATING_SITES = SITES.map((site) => site.id)
// ?ratings=e621:sq,danbooru:s - a site's allowed ratings, one letter each.
const RATING_LETTERS = { safe: 's', sketchy: 'q', unsafe: 'e' }
const DEFAULT_SOURCES = [LIBRARY_SOURCE]
const HOME_ROUTE = 'home'

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

const allRatings = () => Object.fromEntries(SAFETY_ORDER.map((level) => [level, true]))

// Every booru with all three ratings on, then `partial` applied. A site must
// keep at least one rating; one that would keep none stays all on.
function normalizeRatings(partial) {
  const ratings = {}
  for (const site of RATING_SITES) {
    const given = partial && typeof partial === 'object' ? partial[site] : null
    const levels = Object.fromEntries(SAFETY_ORDER.map((level) => [level, given?.[level] !== false]))
    ratings[site] = SAFETY_ORDER.some((level) => levels[level]) ? levels : allRatings()
  }
  return ratings
}

function ratingsToParam(ratings) {
  const parts = []
  for (const site of RATING_SITES) {
    const levels = ratings[site]
    if (SAFETY_ORDER.every((level) => levels[level])) continue
    parts.push(`${site}:${SAFETY_ORDER.filter((level) => levels[level]).map((level) => RATING_LETTERS[level]).join('')}`)
  }
  return parts.length ? parts.join(',') : undefined
}

function ratingsFromParam(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  const partial = {}
  for (const part of raw.split(',')) {
    const [site, letters = ''] = part.split(':')
    if (!RATING_SITES.includes(site)) continue
    partial[site] = Object.fromEntries(SAFETY_ORDER.map((level) => [level, letters.includes(RATING_LETTERS[level])]))
  }
  return normalizeRatings(partial)
}

function loadRatings() {
  try {
    return normalizeRatings(JSON.parse(localStorage.getItem(RATINGS_STORAGE_KEY) || '{}'))
  } catch {
    return normalizeRatings({})
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
  const ratings = ref(loadRatings())

  const libraryTicked = computed(() => sources.value.includes(LIBRARY_SOURCE))
  const remoteSites = computed(() => sources.value.filter((id) => id !== LIBRARY_SOURCE))

  function toRouteQuery() {
    const onlyLibrary = sources.value.length === 1 && sources.value[0] === LIBRARY_SOURCE
    return {
      sources: onlyLibrary ? undefined : sources.value.join(','),
      layout: layout.value === 'interleaved' ? 'interleaved' : undefined,
      ratings: ratingsToParam(ratings.value),
    }
  }

  // Bring the current route's query in line with the store, replacing (not
  // pushing) the history entry. Other query keys are kept as they are. Only
  // the home route carries ?sources/?layout/?ratings; any other route is left alone.
  function syncRoute() {
    const route = router.currentRoute.value
    if (route.name !== HOME_ROUTE) return Promise.resolve()
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

  function commit(nextSources, nextLayout = layout.value, nextRatings = ratings.value) {
    sources.value = nextSources
    layout.value = nextLayout
    ratings.value = nextRatings
    save(SOURCES_STORAGE_KEY, JSON.stringify(nextSources))
    save(LAYOUT_STORAGE_KEY, nextLayout)
    save(RATINGS_STORAGE_KEY, JSON.stringify(nextRatings))
    return syncRoute()
  }

  // The ratings a booru may show: { safe, sketchy, unsafe }. The search
  // intersects them with the global safety filter.
  function siteRatings(site) {
    return ratings.value[site] || allRatings()
  }

  // Switch one rating of one booru. Its last rating cannot be switched off.
  function toggleRating(site, level) {
    if (!RATING_SITES.includes(site) || !SAFETY_ORDER.includes(level)) return false
    const current = siteRatings(site)
    const next = { ...current, [level]: !current[level] }
    if (!SAFETY_ORDER.some((key) => next[key])) return false
    commit(sources.value, layout.value, { ...ratings.value, [site]: next })
    return true
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

  // Read ?sources=a,b, ?layout=interleaved and ?ratings=. A parameter that is present
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
    const nextRatings = query.ratings !== undefined && query.ratings !== null ? ratingsFromParam(query.ratings) : ratings.value
    return commit(nextSources, nextLayout, nextRatings)
  }

  return {
    sources,
    layout,
    ratings,
    siteRatings,
    toggleRating,
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
