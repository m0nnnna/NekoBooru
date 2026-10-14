import { librarySpellingResolver } from './e621Names.js'
import { parseQuery } from './queryTranslation.js'

// The library stores tag names flattened (yui_(angel_beats!) as
// yui_angel_beats); a booru only knows its own spelling, which survives in
// the tag's display name. Rewrites every tag term of a home-search query to
// that spelling, word by word, so OR, the -/~ prefixes and meta terms
// (rating:s, order:score, md5:...) pass through untouched.

async function spellWord(word, resolve) {
  if (word.toUpperCase() === 'OR') return word
  const [token] = parseQuery(word)
  if (!token || token.kind === 'meta') return word
  const prefix = word.startsWith('-') || word.startsWith('~') ? word[0] : ''
  const spelled = await resolve(token.value.toLowerCase())
  return spelled ? `${prefix}${spelled}` : word
}

export async function booruSpellingQuery(query, resolve) {
  const words = String(query ?? '').split(/\s+/).filter(Boolean)
  return (await Promise.all(words.map((word) => spellWord(word, resolve)))).join(' ')
}

/**
 * One speller per results instance: speller(query) -> the query as the
 * boorus spell it. Without a tag lookup (`api.getTag`) it returns the query
 * itself synchronously, so a search with nothing to look up never waits; with
 * one it returns a promise, shared by every booru searching the same query.
 */
export function createBooruSpeller(api) {
  const resolve = librarySpellingResolver(api)
  let last = { query: null, spelled: null }
  return (query) => {
    if (!resolve || !query) return query
    if (last.query !== query) last = { query, spelled: booruSpellingQuery(query, resolve).catch(() => query) }
    return last.spelled
  }
}
