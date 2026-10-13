import api from '../api/client'
import { booruSearchTag } from './booruSearchTag.js'
import { openResolvedSearch } from './resolvedSearch.js'

export const E621_ORIGIN = 'https://e621.net'

export function e621SearchUrl(tag) {
  return `${E621_ORIGIN}/posts?tags=${encodeURIComponent(tag)}`
}

// The e621 search a tag link points at before anything is looked up.
export function e621FallbackUrl(tag) {
  return e621SearchUrl(tag?.e621Name || booruSearchTag(tag?.name, tag?.displayName))
}

// A plain left click on an e621 link: when the tag has no e621 name yet, ask
// the backend (it looks it up once and remembers it), so hirasawa_yui
// searches yui_hirasawa there. See openResolvedSearch.
export async function openE621Search(event, tag, deps = {}) {
  const resolveName = deps.resolveName || ((name) => api.resolveE621Name(name))
  return openResolvedSearch(event, {
    known: tag?.e621Name,
    fallback: booruSearchTag(tag?.name, tag?.displayName),
    resolve: async () => (await resolveName(tag?.name))?.e621Name,
    urlFor: e621SearchUrl,
  }, deps)
}
