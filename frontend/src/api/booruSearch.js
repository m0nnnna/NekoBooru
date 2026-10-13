import { request } from './request.js'

// Booru search relays and lookups (docs/booru-search-plan.md section 2).
export const booruSearchApi = {
  // Booru search (docs/booru-search-plan.md section 2)
  async getBooruSearchStatus() { return request('/booru-search/status') },
  async searchGelbooru(params, signal) { return request(`/booru-search/gelbooru?${new URLSearchParams(params)}`, { signal }) },
  async searchSafebooru(params, signal) { return request(`/booru-search/safebooru?${new URLSearchParams(params)}`, { signal }) },
  async lookupInLibrary(keys) { return request('/booru-search/in-library', { method: 'POST', body: JSON.stringify({ keys }) }) },
  async gelbooruTagCategories(tags) { return request('/booru-search/gelbooru-categories', { method: 'POST', body: JSON.stringify({ tags }) }) },
  // The plan calls this both as (tags, tagCategories) and as ({ tags, tagCategories }); accept either.
  async danbooruNames(tags, tagCategories) {
    const body = Array.isArray(tags) ? { tags, tagCategories } : { tags: tags?.tags, tagCategories: tags?.tagCategories }
    return request('/site-imports/danbooru-names', { method: 'POST', body: JSON.stringify(body) })
  },
}
