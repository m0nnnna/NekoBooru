import api from '../api/client'
import { SANKAKU_CHAN, booruSearchTag, sankakuSearchUrl } from './booruSearchTag.js'
import { openResolvedSearch } from './resolvedSearch.js'

// The Sankaku search a tag link points at before anything is looked up: the
// stored Sankaku name when the tag has one, else the booru spelling.
export function sankakuFallbackUrl(tag, origin = SANKAKU_CHAN) {
  return sankakuSearchUrl(tag?.sankakuName || booruSearchTag(tag?.name, tag?.displayName), origin)
}

// A plain left click on a Sankaku link: when the tag has no Sankaku name yet,
// ask the backend for one first (it looks it up once and remembers it), so
// honoka_doa searches honoka_(dead_or_alive) there. See openResolvedSearch.
export async function openSankakuSearch(event, tag, origin = SANKAKU_CHAN, deps = {}) {
  const resolveName = deps.resolveName || ((name) => api.resolveSankakuName(name))
  return openResolvedSearch(event, {
    known: tag?.sankakuName,
    fallback: booruSearchTag(tag?.name, tag?.displayName),
    resolve: async () => (await resolveName(tag?.name))?.sankakuName,
    urlFor: (name) => sankakuSearchUrl(name, origin),
  }, deps)
}
