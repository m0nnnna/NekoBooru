import { SAFETY_ORDER } from './types.js'

// Turns the home view's library query into each booru's search string
// (section 3.3 of docs/booru-search-plan.md). Plain tags go everywhere as
// typed; NekoBooru's rating checkboxes, sort and filters are translated where
// a site understands them, and everything else is reported as ignored so the
// section header can say so. Pure: no requests, no state.

export const DANBOORU_META = ['id', 'user', 'score', 'favcount', 'width', 'height', 'mpixels', 'ratio', 'filesize', 'filetype', 'source', 'parent', 'child', 'status', 'date', 'age', 'order', 'rating', 'pool', 'approver', 'tagcount', 'duration', 'md5']
export const SANKAKU_META = ['id', 'user', 'score', 'width', 'height', 'source', 'parent', 'rating', 'date', 'md5', 'file_type', 'threshold']
export const GELBOORU_META = ['id', 'user', 'score', 'width', 'height', 'source', 'parent', 'rating', 'sort', 'md5', 'status']

// Filters only the library understands (backend/app/services/search.py
// FILTER_KEYS minus the ones translated below). Their local meaning would be
// wrong on a booru even where the booru has a metatag of the same name.
const NEKOBOORU_ONLY = new Set(['sha256', 'fav', 'favorite', 'pool', 'type', 'sort'])
const NEKOBOORU_FILTERS = new Set(['rating', 'safety', 'width', 'height', 'hash', 'md5', ...NEKOBOORU_ONLY])

// A token is a metatag when its key is one some side understands; anything
// else with a colon ('re:zero_...', ':d') is a tag, as in the library search.
const KNOWN_META = new Set([...NEKOBOORU_FILTERS, ...DANBOORU_META, ...SANKAKU_META, ...GELBOORU_META])

const SITE_META = {
  danbooru: new Set(DANBOORU_META),
  e621: new Set(DANBOORU_META),
  sankaku: new Set(SANKAKU_META),
  gelbooru: new Set(GELBOORU_META),
  safebooru: new Set(GELBOORU_META),
}

// The site's rating values for each NekoBooru safety, in the site's terms.
const RATING_VALUES = {
  danbooru: { safe: ['g'], sketchy: ['s', 'q'], unsafe: ['e'] },
  e621: { safe: ['s'], sketchy: ['q'], unsafe: ['e'] },
  sankaku: { safe: ['s'], sketchy: ['q'], unsafe: ['e'] },
  gelbooru: { safe: ['general'], sketchy: ['sensitive', 'questionable'], unsafe: ['explicit'] },
  safebooru: { safe: ['general'], sketchy: ['questionable'], unsafe: ['explicit'] },
}

// Rating words every site's users might type, beyond the site's own letters.
const RATING_WORDS = {
  safe: 'safe', sketchy: 'sketchy', unsafe: 'unsafe',
  general: 'safe', sensitive: 'sketchy', questionable: 'sketchy', explicit: 'unsafe',
  g: 'safe', q: 'sketchy', e: 'unsafe',
}
// 's' is "sensitive" on Danbooru and Gelbooru but "safe" on e621, Sankaku and Safebooru.
const RATING_S = { danbooru: 'sketchy', e621: 'safe', sankaku: 'safe', gelbooru: 'sketchy', safebooru: 'safe' }

const SORT_TERMS = {
  danbooru: { asc: 'order:id', sizeDesc: 'order:filesize', sizeAsc: 'order:filesize_asc' },
  e621: { asc: 'order:id', sizeDesc: 'order:filesize', sizeAsc: 'order:filesize_asc' },
  gelbooru: { asc: 'sort:id:asc', sizeDesc: null, sizeAsc: null },
  safebooru: { asc: 'sort:id:asc', sizeDesc: null, sizeAsc: null },
  sankaku: { asc: null, sizeDesc: null, sizeAsc: null },
}

const OR_SITES = new Set(['danbooru', 'e621'])
export const DANBOORU_TERM_LIMIT = 2
// Sankaku answers more than four terms from an anonymous caller with HTTP 429
// code snackbar__anonymous_tags-limit (verified 2026-10-13).
export const SANKAKU_TERM_LIMIT = 4
// Anonymous term budgets: rating, order and other metatags count like tags.
const TERM_LIMITS = {
  danbooru: { limit: DANBOORU_TERM_LIMIT, label: 'Danbooru' },
  sankaku: { limit: SANKAKU_TERM_LIMIT, label: 'Sankaku' },
}

const OPS = ['>=', '<=', '>', '<']
const BARE_HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/i
const MD5 = /^[0-9a-f]{32}$/i

function parseMeta(body) {
  const colon = body.indexOf(':')
  if (colon <= 0) return null
  const key = body.slice(0, colon).toLowerCase()
  if (!KNOWN_META.has(key)) return null
  let value = body.slice(colon + 1)
  const op = OPS.find((candidate) => value.startsWith(candidate)) || ''
  value = value.slice(op.length)
  return { key, op, value }
}

/**
 * Tokenises a library query on whitespace.
 * -> [{ kind: 'tag'|'neg'|'or'|'meta', value, key?, op?, negated?, raw }]
 *
 * `meta` is `key:value` for a key some side understands, with `op` one of
 * '' '>' '>=' '<' '<=' and `negated` for `-key:value`. A bare 32/64-digit hex
 * string is a `hash` meta, as in the library search. `or` is `~tag`; the
 * library's `a OR b` keyword is read the same way (both operands become `or`
 * tokens and the keyword itself is dropped), which on a booru is a superset of
 * the library's grouping.
 */
export function parseQuery(q) {
  const parts = String(q ?? '').split(/\s+/).filter(Boolean)
  const tokens = []
  let joinNext = false
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i]
    if (raw.toUpperCase() === 'OR' && tokens.length && i < parts.length - 1) {
      const previous = tokens[tokens.length - 1]
      if (previous.kind === 'tag') Object.assign(previous, { kind: 'or' })
      joinNext = true
      continue
    }
    let token
    if (raw.startsWith('-') && raw.length > 1) {
      const meta = parseMeta(raw.slice(1))
      token = meta ? { kind: 'meta', ...meta, negated: true, raw } : { kind: 'neg', value: raw.slice(1), raw }
    } else if (raw.startsWith('~') && raw.length > 1) {
      token = { kind: 'or', value: raw.slice(1), raw }
    } else if (BARE_HASH.test(raw)) {
      token = { kind: 'meta', key: 'hash', op: '', value: raw, negated: false, raw }
    } else {
      const meta = parseMeta(raw)
      token = meta ? { kind: 'meta', ...meta, negated: false, raw } : { kind: 'tag', value: raw, raw }
    }
    if (joinNext && token.kind === 'tag') token.kind = 'or'
    joinNext = false
    tokens.push(token)
  }
  return tokens
}

// One rating value (or comma list) -> the NekoBooru safeties it names, or
// null when any part is not a rating this site understands.
function safetiesFor(site, value) {
  const found = new Set()
  for (const part of String(value).toLowerCase().split(',')) {
    const safety = part === 's' ? RATING_S[site] : RATING_WORDS[part]
    if (!safety) return null
    found.add(safety)
  }
  return found.size ? found : null
}

function ratingTerms(site, allowed) {
  if (SAFETY_ORDER.every((safety) => allowed.has(safety))) return []
  const values = RATING_VALUES[site]
  if (site === 'danbooru') {
    const letters = SAFETY_ORDER.filter((safety) => allowed.has(safety)).flatMap((safety) => values[safety])
    return letters.length ? [`rating:${letters.join(',')}`] : []
  }
  if (site === 'sankaku') {
    // Every term counts against the anonymous budget: one rating:x for a
    // single allowed value says what two -rating:y would.
    const kept = SAFETY_ORDER.filter((safety) => allowed.has(safety)).flatMap((safety) => values[safety])
    if (kept.length === 1) return [`rating:${kept[0]}`]
  }
  return SAFETY_ORDER.filter((safety) => !allowed.has(safety)).flatMap((safety) => values[safety].map((value) => `-rating:${value}`))
}

// -> { term: string|null, ignored: string|null }
function sortTerm(site, sort, order) {
  const table = SORT_TERMS[site]
  if (sort === 'size') {
    const term = order === 'asc' ? table.sizeAsc : table.sizeDesc
    return term ? { term, ignored: null } : { term: null, ignored: 'size sorting' }
  }
  if (order !== 'asc') return { term: null, ignored: null }
  return table.asc ? { term: table.asc, ignored: null } : { term: null, ignored: 'oldest-first' }
}

// The single plain tag a query consists of, lower-cased; null for anything
// else (several terms, a negation, a metatag, a wildcard). Per-tag post
// counts (e621's tags.json, Sankaku's tag rows) estimate only this case.
export function singlePlainTag(q) {
  const tokens = parseQuery(q)
  if (tokens.length !== 1 || tokens[0].kind !== 'tag') return null
  const tag = tokens[0].value.toLowerCase()
  return tag.includes('*') ? null : tag
}

function metaTerm(token) {
  return `${token.negated ? '-' : ''}${token.key}:${token.op}${token.value}`
}

/**
 * translateQuery(site, q, options)
 *   -> { tags: string, terms: string[], ignored: string[], clientSafetyFilter: boolean, note: string|null }
 *
 * `options` = { safety: { safe, sketchy, unsafe }, sort: 'date'|'id'|'size', order: 'asc'|'desc' };
 * missing safety keys count as ticked. `q` must not carry the -safety:
 * exclusions the home view adds for the library request.
 */
export function translateQuery(site, q, options = {}) {
  if (!SITE_META[site]) throw new Error(`Unknown booru site: ${site}`)
  const checkboxes = options.safety || {}
  const allowed = new Set(SAFETY_ORDER.filter((safety) => checkboxes[safety] !== false))
  const meta = SITE_META[site]
  const ignored = []
  const plain = []
  const negations = []
  const ors = []
  const others = []

  for (const token of parseQuery(q)) {
    if (token.kind === 'tag') plain.push(token.raw)
    else if (token.kind === 'neg') negations.push(token.raw)
    else if (token.kind === 'or') {
      if (OR_SITES.has(site)) ors.push(`~${token.value}`)
      else ignored.push(token.raw)
    } else if (token.key === 'safety' || token.key === 'rating') {
      const named = safetiesFor(site, token.value)
      if (!named || token.op) ignored.push(token.raw)
      else for (const safety of SAFETY_ORDER) {
        if (token.negated ? named.has(safety) : !named.has(safety)) allowed.delete(safety)
      }
    } else if (token.key === 'md5' || token.key === 'hash') {
      if (MD5.test(token.value) && !token.op) others.push(`${token.negated ? '-' : ''}md5:${token.value.toLowerCase()}`)
      else ignored.push(token.raw)
    } else if (token.key === 'width' || token.key === 'height') {
      others.push(metaTerm(token))
    } else if (NEKOBOORU_ONLY.has(token.key) || !meta.has(token.key)) {
      ignored.push(token.raw)
    } else {
      others.push(metaTerm(token))
    }
  }

  const rating = ratingTerms(site, allowed)
  const sorting = sortTerm(site, options.sort || 'date', options.order || 'desc')
  if (sorting.ignored) ignored.push(sorting.ignored)
  // Fixed priority, which is also the term budgets' cut order.
  let terms = [...new Set([...plain, ...negations, ...ors, ...rating, ...(sorting.term ? [sorting.term] : []), ...others])]
  let note = null
  const budget = TERM_LIMITS[site]
  if (budget && terms.length > budget.limit) {
    const cut = terms.slice(budget.limit)
    terms = terms.slice(0, budget.limit)
    ignored.push(...cut)
    note = `${budget.label} allows ${budget.limit} search terms without an account; ignored: ${cut.join(', ')}`
  }
  return { tags: terms.join(' '), terms, ignored, clientSafetyFilter: true, note }
}
