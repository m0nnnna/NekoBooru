import { parseQuery } from './queryTranslation.js'

// Library tag spelling -> another booru's, in the browser, for the
// aggregated search. The same candidates and ranking as the backend's
// services/e621_names.py: the library is Danbooru-spelled (hirasawa_yui), e621
// orders names given-name first (yui_hirasawa) and spells some qualifiers in
// full (honoka_(dead_or_alive) for honoka_(doa)).
//
// Answers are cached in memory and in localStorage for a day. A failure
// leaves the term as it is and is not cached, so the next search asks again.

const E621 = 'https://e621.net'
const DANBOORU = 'https://danbooru.donmai.us'
export const E621_CLIENT = 'NekoBooru/1.0'
export const NAME_CACHE_MS = 24 * 3600 * 1000
const FETCH_INIT = { headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' }

const TWO_PART_NAME = /^([^_()]+)_([^_()]+)(_\([^()]+\))?$/
const QUALIFIED = /^(.+?)_\(([^()]+)\)$/

/** The other order of a two-part name, keeping any _(qualifier); null otherwise. */
export function swappedName(spelling) {
  const match = TWO_PART_NAME.exec(String(spelling ?? ''))
  return match ? `${match[2]}_${match[1]}${match[3] || ''}` : null
}

export function qualifierOf(spelling) {
  return QUALIFIED.exec(String(spelling ?? ''))?.[2] || ''
}

/** spelling's name with each longer form of its qualifier. */
export function qualifierVariants(spelling, expansions = []) {
  const match = QUALIFIED.exec(String(spelling ?? ''))
  return match ? expansions.map((longer) => `${match[1]}_(${longer})`) : []
}

/** e621 candidates, the spelling first: e621's alias, the swapped order, expanded qualifiers on both orders. */
export function e621Candidates(spelling, alias, expansions = []) {
  const swapped = swappedName(spelling)
  const names = [spelling, alias, swapped, ...qualifierVariants(spelling, expansions), ...qualifierVariants(swapped, expansions)]
  return [...new Set(names.filter(Boolean))]
}

async function getRows(url, { fetch: fetchImpl, signal }) {
  const response = await (fetchImpl || globalThis.fetch)(url, { ...FETCH_INIT, signal })
  if (!response?.ok) throw new Error(`HTTP ${response?.status}`)
  const body = await response.json()
  // e621 answers an empty search with {"tags": []} / {"tag_aliases": []}.
  return Array.isArray(body) ? body.filter((row) => row && typeof row === 'object') : []
}

function e621Url(path, params) {
  return `${E621}${path}?${new URLSearchParams({ ...params, _client: E621_CLIENT })}`
}

/** Danbooru's longer names for a qualifier (doa -> dead_or_alive). */
export async function danbooruExpansions(qualifier, deps = {}) {
  if (!qualifier) return []
  const params = new URLSearchParams({
    'search[antecedent_name]': qualifier,
    'search[status]': 'active',
    only: 'antecedent_name,consequent_name',
  })
  const rows = await getRows(`${DANBOORU}/tag_aliases.json?${params}`, deps)
  return rows.filter((row) => row.antecedent_name === qualifier && row.consequent_name).map((row) => String(row.consequent_name))
}

/** e621's name for `spelling`: the candidate with the most posts; the spelling when none has any. Throws on failure. */
export async function lookupE621Name(spelling, deps = {}) {
  const aliases = await getRows(e621Url('/tag_aliases.json', { 'search[antecedent_name]': spelling, 'search[status]': 'active' }), deps)
  const alias = aliases.find((row) => row.antecedent_name === spelling)?.consequent_name || null
  const expansions = await danbooruExpansions(qualifierOf(spelling), deps)
  const candidates = e621Candidates(spelling, alias, expansions)
  const rows = await getRows(e621Url('/tags.json', { 'search[name]': candidates.join(','), limit: String(candidates.length) }), deps)
  const counts = new Map(rows.map((row) => [String(row.name), Number(row.post_count) || 0]))
  let best = spelling
  let bestCount = 0
  for (const name of candidates) {
    if ((counts.get(name) || 0) > bestCount) {
      best = name
      bestCount = counts.get(name)
    }
  }
  return best
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

/**
 * Wraps lookup(spelling, deps) -> name with a day-long cache in memory and in
 * localStorage under `storageKey`. Failures resolve to the spelling and are
 * not cached. deps: { fetch, signal, storage, now }.
 */
export function cachedNameResolver(storageKey, lookup) {
  const memory = new Map()

  function readStored(storage) {
    try {
      const parsed = JSON.parse(storage?.getItem(storageKey) || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  // A search and its count ask about the same term at once: one lookup serves both.
  const inflight = new Map()

  function resolve(spelling, deps = {}) {
    const now = (deps.now || Date.now)()
    const storage = deps.storage === undefined ? defaultStorage() : deps.storage
    const hit = memory.get(spelling) || readStored(storage)[spelling]
    if (hit && now - hit.at < NAME_CACHE_MS && typeof hit.name === 'string') {
      memory.set(spelling, hit)
      return Promise.resolve(hit.name)
    }
    if (!inflight.has(spelling)) {
      const pending = ask(spelling, deps, now, storage).finally(() => inflight.delete(spelling))
      inflight.set(spelling, pending)
    }
    return inflight.get(spelling)
  }

  async function ask(spelling, deps, now, storage) {
    let name
    try {
      name = await lookup(spelling, deps)
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      return spelling
    }
    const entry = { name: name || spelling, at: now }
    memory.set(spelling, entry)
    try {
      const stored = readStored(storage)
      for (const [key, value] of Object.entries(stored)) {
        if (!value || now - value.at >= NAME_CACHE_MS) delete stored[key]
      }
      stored[spelling] = entry
      storage?.setItem(storageKey, JSON.stringify(stored))
    } catch {
      // Private mode or a full quota: the memory cache still holds it.
    }
    return entry.name
  }

  resolve.clear = () => memory.clear()
  return resolve
}

export const resolveE621Name = cachedNameResolver('nekobooru.e621Names', lookupE621Name)

// The plain tag terms of `query` (no wildcards), lower-cased as the boorus store them.
function plainTerms(query) {
  return new Set(
    parseQuery(query)
      .filter((token) => token.kind === 'tag' && !token.raw.includes('*'))
      .map((token) => token.raw),
  )
}

/**
 * Maps the plain tag terms of a translated query through `resolve`.
 * -> { terms, mapped: [[from, to]], note: string|null }
 * `label` names the site in the note.
 */
export async function mapPlainTerms(query, terms, resolve, label, deps = {}) {
  const plain = plainTerms(query)
  const mapped = []
  const out = []
  for (const term of terms) {
    if (!plain.has(term)) {
      out.push(term)
      continue
    }
    const spelling = term.toLowerCase()
    const name = await resolve(spelling, deps)
    if (name && name !== spelling) mapped.push([term, name])
    out.push(name || term)
  }
  const note = mapped.length ? `Searched ${label} as ${mapped.map(([from, to]) => `${from} → ${to}`).join(', ')}` : null
  return { terms: out, mapped, note }
}

/** Joins a translation's own note with a mapping note. */
export function joinNotes(...notes) {
  const kept = notes.filter(Boolean)
  return kept.length ? kept.join('; ') : null
}
