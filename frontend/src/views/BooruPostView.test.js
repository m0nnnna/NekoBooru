// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ inLibrary: {} }))

vi.mock('../api/client', () => {
  const api = {
    lookupInLibrary: vi.fn(async (keys) => ({
      found: Object.fromEntries(keys.filter((key) => hoisted.inLibrary[key]).map((key) => [key, { postId: hoisted.inLibrary[key] }])),
    })),
    getPost: vi.fn(async (id) => ({ id, tags: ['cat'], tagDetails: [], safety: 'safe' })),
    updatePost: vi.fn(async (id, body) => ({ id, ...body })),
    createAlias: vi.fn(async () => ({})),
    getCategories: vi.fn(async () => [{ name: 'character', color: '#00aa00' }, { name: 'general', color: '#0075f8' }]),
  }
  return { api, default: api }
})

import BooruPostView from './BooruPostView.vue'
import { useAuthStore } from '../stores/auth'
import { useBooruPostContextStore } from '../stores/booruPostContext'

function remotePost(site, id, extra = {}) {
  return {
    key: `${site}:${id}`,
    site,
    id: String(id),
    postUrl: `https://example.test/${site}/${id}`,
    thumbUrl: `https://cdn.example.test/${site}/${id}-thumb.jpg`,
    sampleUrl: null,
    fileUrl: `https://cdn.example.test/${site}/${id}.png`,
    width: 800,
    height: 600,
    fileExt: 'png',
    mediaType: 'image',
    fileSize: 4096,
    safety: 'sketchy',
    rawRating: 's',
    tags: ['hatsune_miku', 'smile'],
    tagCategories: { hatsune_miku: 'character', smile: 'general' },
    tagDisplayNames: {},
    source: 'https://www.pixiv.net/artworks/1',
    md5: null,
    score: 3,
    createdAt: '2026-01-02T03:04:05Z',
    unavailable: null,
    referer: '',
    ...extra,
  }
}

const SECTION = [
  remotePost('danbooru', 1),
  remotePost('danbooru', 2, { postUrl: 'https://danbooru.donmai.us/posts/2' }),
  remotePost('sankaku', 'Ab3'),
]

async function mountPage(path, { context = SECTION, canBrowseBoorus = true } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div class="home" />' } },
      { path: '/post/:id', name: 'post', component: { template: '<div />' } },
      { path: '/tags', component: { template: '<div />' } },
      { path: '/booru/:site/:id', name: 'booru-post', component: BooruPostView },
    ],
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { id: 1, username: 'neko', canBrowseBoorus }
  if (context) useBooruPostContextStore().open(context)
  router.push(path)
  await router.isReady()
  const wrapper = mount({ template: '<router-view />' }, { global: { plugins: [pinia, router] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, router }
}

describe('BooruPostView', () => {
  beforeEach(() => {
    localStorage.clear()
    hoisted.inLibrary = {}
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('shows a booru post in the native post frame without the library-only panels', async () => {
    const { wrapper } = await mountPage('/booru/danbooru/2')
    expect(wrapper.find('.post-view .media-container').exists()).toBe(true)
    const img = wrapper.get('.media-container img')
    expect(img.attributes('src')).toBe(SECTION[1].fileUrl)
    // Danbooru's CDN wants the browser's default referrer.
    expect(img.attributes('referrerpolicy')).toBeUndefined()
    expect(wrapper.get('.post-info-id').text()).toContain('#2')
    expect(wrapper.get('.post-info-meta').text()).toContain('800 × 600')
    expect(wrapper.get('.post-info-meta').text()).toContain('4.0 KB')
    expect(wrapper.get('.post-info-sources').text()).toContain('pixiv.net')
    expect(wrapper.get('.safety-btn.sketchy').classes()).toContain('active')
    expect(wrapper.get('.safety-btn.safe').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('.tag-group-heading').map((h) => h.text())).toEqual(['Character', 'Tag'])
    expect(wrapper.get('.tag-group-heading').attributes('style')).toContain('color: rgb(0, 170, 0)')

    for (const selector of ['.edit-tags-btn', '.post-tools-tab', '.semantic-description-card', '.comment-section']) {
      expect(wrapper.find(selector).exists()).toBe(false)
    }
    const buttons = wrapper.findAll('button').map((button) => button.text())
    expect(buttons).not.toContain('Delete')
    expect(buttons.some((text) => /Favorite|Add to Pool|Optimize/.test(text))).toBe(false)
  })

  it('offers Import to NekoBooru and Open on the booru, prominently above the tags', async () => {
    const { wrapper } = await mountPage('/booru/danbooru/2')
    const sections = wrapper.findAll('.post-sidebar > .sidebar-section')
    expect(sections[1].classes()).toContain('booru-actions')
    expect(wrapper.get('.booru-import').text()).toBe('Import to NekoBooru')
    const site = wrapper.get('.booru-site-link')
    expect(site.text()).toBe('Open on Danbooru')
    expect(site.attributes('href')).toBe('https://danbooru.donmai.us/posts/2')
    expect(site.attributes('target')).toBe('_blank')
    expect(site.attributes('rel')).toBe('noopener noreferrer')
  })

  it('turns Import into View in library once the import lands', async () => {
    const { api } = await import('../api/client')
    const { wrapper } = await mountPage('/booru/danbooru/2')
    expect(wrapper.find('.booru-library-link').exists()).toBe(false)

    // The queue checks the library first: the post turns out to be there, so it merges.
    hoisted.inLibrary = { 'danbooru:2': 42 }
    await wrapper.get('.booru-import').trigger('click')
    await flushPromises()
    expect(api.updatePost).toHaveBeenCalledWith(42, expect.any(Object))
    expect(wrapper.find('.booru-import').exists()).toBe(false)
    const link = wrapper.get('.booru-library-link')
    expect(link.text()).toBe('View in library')
    expect(link.attributes('href')).toBe('/post/42')
    expect(wrapper.get('.booru-status').text()).toContain('#42')
    expect(useBooruPostContextStore().libraryIdFor('danbooru:2')).toBe(42)
  })

  it('links a post the library already has from the start', async () => {
    hoisted.inLibrary = { 'danbooru:1': 7 }
    const { wrapper } = await mountPage('/booru/danbooru/1')
    expect(wrapper.find('.booru-import').exists()).toBe(false)
    expect(wrapper.get('.booru-library-link').attributes('href')).toBe('/post/7')
  })

  it('steps through the section it was opened from, by arrow button and key', async () => {
    const { wrapper, router } = await mountPage('/booru/danbooru/2')
    expect(wrapper.find('.nav-prev').exists()).toBe(true)
    await wrapper.get('.nav-next').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/booru/sankaku/Ab3')
    expect(wrapper.find('.nav-next').exists()).toBe(false)
    // Sankaku's CDN refuses this app's origin as a Referer.
    expect(wrapper.get('.media-container img').attributes('referrerpolicy')).toBe('no-referrer')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/booru/danbooru/2')
  })

  it('plays a video post from its original', async () => {
    const video = remotePost('e621', 5, { fileExt: 'webm', mediaType: 'video', fileUrl: 'https://static1.e621.net/data/x.webm' })
    const { wrapper } = await mountPage('/booru/e621/5', { context: [video] })
    expect(wrapper.get('.media-container video').attributes('src')).toBe(video.fileUrl)
  })

  it('fetches a post opened from its URL alone and hides Prev / Next', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 9,
      file_ext: 'png',
      file_url: 'https://cdn.donmai.us/original/aa/bb/x.png',
      image_width: 10,
      image_height: 20,
      rating: 'g',
      tag_string_general: 'cat',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    try {
      const { wrapper } = await mountPage('/booru/danbooru/9', { context: null })
      expect(String(fetch.mock.calls[0][0])).toBe('https://danbooru.donmai.us/posts/9.json')
      expect(wrapper.get('.media-container img').attributes('src')).toBe('https://cdn.donmai.us/original/aa/bb/x.png')
      expect(wrapper.find('.nav-prev').exists()).toBe(false)
      expect(wrapper.find('.nav-next').exists()).toBe(false)
      expect(wrapper.get('.booru-site-link').text()).toBe('Open on Danbooru')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('explains a post that cannot be loaded', async () => {
    const { wrapper } = await mountPage('/booru/myspace/1', { context: null })
    expect(wrapper.get('.booru-post-missing').text()).toContain('not a booru NekoBooru searches')
  })

  it('leaves for home when booru search is switched off', async () => {
    const { router } = await mountPage('/booru/danbooru/2')
    useAuthStore().user = { id: 1, username: 'neko', canBrowseBoorus: false }
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('home')
  })
})
