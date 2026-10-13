// @vitest-environment jsdom
import AI_MODEL_REGISTRY from '../composables/aiModelRegistry.fixture.json'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Home -> booru post -> Back keeps the home view as it was (the old overlay
// viewer never left it): booru pages, scroll, selection, the import queue.
const hoisted = vi.hoisted(() => {
  const remotePost = (site, id) => ({
    key: `${site}:${id}`,
    site,
    id: String(id),
    postUrl: `https://${site}.example/posts/${id}`,
    thumbUrl: null,
    sampleUrl: null,
    fileUrl: `https://cdn.${site}.example/original/${id}.png`,
    width: 800,
    height: 600,
    fileExt: 'png',
    mediaType: 'image',
    fileSize: 1000,
    safety: 'safe',
    rawRating: 'g',
    tags: ['cat_ears'],
    tagCategories: { cat_ears: 'general' },
    tagDisplayNames: {},
    source: null,
    unavailable: null,
    referer: `https://${site}.example/`,
  })
  const danbooru = {
    id: 'danbooru',
    translate: () => ({ ignored: [], note: null }),
    pageCursor: (page) => ({ page }),
    search: null,
  }
  return { adapters: { danbooru }, router: null, remotePost }
})

vi.mock('../api/client', () => {
  const api = {
    getAutoTagSettings: vi.fn(async () => ({})),
    getAiModelDefaults: vi.fn(async () => ({ modelDefaults: {} })),
    getAutoTagRegistry: vi.fn(async () => AI_MODEL_REGISTRY),
    getPostAiAnalysis: vi.fn(async () => ({ results: [] })),
    lookupInLibrary: vi.fn(async () => ({ found: {} })),
    getPools: vi.fn(async () => ({ results: [] })),
    fetchFromUrl: vi.fn(),
    getFromUrlProgress: vi.fn(async () => ({ received: 0, total: 0 })),
    createPost: vi.fn(async (body) => ({ id: 42, tags: body.tags, safety: body.safety })),
    getPost: vi.fn(async (id) => ({ id, tags: ['cat'], safety: 'safe' })),
    updatePost: vi.fn(async (id, body) => ({ id, ...body })),
    danbooruNames: vi.fn(async () => ({ renames: {} })),
    gelbooruTagCategories: vi.fn(async () => ({ categories: {} })),
    createAlias: vi.fn(async () => ({})),
  }
  return { api, default: api }
})
vi.mock('../router', () => ({
  default: {
    get currentRoute() { return hoisted.router.currentRoute },
    replace: (to) => hoisted.router.replace(to),
  },
}))
vi.mock('../remote/adapters/index.js', () => ({
  ADAPTERS: hoisted.adapters,
  adapterFor: (site) => hoisted.adapters[site] || null,
}))

import HomeView from './HomeView.vue'
import KeptRouterView from '../components/KeptRouterView.vue'
import { api } from '../api/client'
import { installHomeKeepAlive, keepHome } from '../router/homeKeepAlive'
import { useAuthStore } from '../stores/auth'
import { useBooruPostContextStore } from '../stores/booruPostContext'

const POSTS = [5, 6].map((id) => ({ id, extension: '.png', width: 100, height: 100, fileSize: 2048, safety: 'safe', tags: ['cat'], thumbUrl: `/thumb/${id}.webp` }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await flushPromises()
    await sleep(0)
  }
}

let mounted = null

async function mountApp() {
  localStorage.setItem('nekobooru.remoteSources', JSON.stringify(['danbooru']))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: HomeView },
      { path: '/booru/:site/:id', name: 'booru-post', component: { template: '<div class="booru-page" />' } },
      { path: '/post/:id', name: 'post', component: { template: '<div />' } },
      { path: '/tags', name: 'tags', component: { template: '<div class="tags-page" />' } },
    ],
  })
  installHomeKeepAlive(router)
  hoisted.router = router
  router.push('/')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { id: 1, username: 'neko', canBrowseBoorus: true }
  const wrapper = mount(KeptRouterView, { attachTo: document.body, global: { plugins: [pinia, router] } })
  mounted = wrapper
  await settle()
  return { wrapper, router }
}

const section = (wrapper) => wrapper.get('.remote-section')
const cardLabels = (wrapper) => section(wrapper).findAll('.remote-card').map((card) => card.attributes('aria-label'))
const batchTitle = (wrapper) => wrapper.get('.batch-title').findAll('span').map((span) => span.text()).join(' ')

describe('HomeView kept alive across the booru post page', () => {
  let release

  beforeEach(() => {
    localStorage.clear()
    keepHome.value = false
    hoisted.adapters.danbooru.search = vi.fn(async ({ cursor }) => {
      const page = cursor?.page || 1
      return { posts: [1, 2, 3].map((n) => hoisted.remotePost('danbooru', page * 10 + n)), nextCursor: { page: page + 1 }, total: 60 }
    })
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ results: POSTS, total: POSTS.length, pages: 1 }) }))
    api.fetchFromUrl.mockReset()
    api.fetchFromUrl.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    api.createPost.mockClear()
    window.scrollTo = vi.fn()
  })

  afterEach(() => {
    mounted?.unmount()
    mounted = null
    document.body.innerHTML = ''
  })

  it('comes back to the same booru page, scroll, selection and running import', async () => {
    const { wrapper, router } = await mountApp()
    const search = hoisted.adapters.danbooru.search
    await section(wrapper).findAll('.pagination button').find((b) => /Next/.test(b.text())).trigger('click')
    // The default per-site budget spaces requests about a second apart.
    await sleep(1100)
    await settle()
    expect(cardLabels(wrapper)).toEqual(['Danbooru post 21', 'Danbooru post 22', 'Danbooru post 23'])
    expect(search).toHaveBeenCalledTimes(2)

    await wrapper.get('.select-toggle').trigger('click')
    await section(wrapper).findAll('.remote-card')[0].trigger('click')
    await section(wrapper).findAll('.remote-card')[1].trigger('click')
    await wrapper.get('.import-card [data-test="start"]').trigger('click')
    await settle()
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)
    const libraryFetches = globalThis.fetch.mock.calls.length

    Object.defineProperty(window, 'scrollY', { value: 480, configurable: true })
    await router.push({ name: 'booru-post', params: { site: 'danbooru', id: '21' } })
    await settle()
    expect(wrapper.find('.booru-page').exists()).toBe(true)
    // The post page imports into this same queue.
    expect(useBooruPostContextStore().importer.queue.items.map((item) => item.key)).toEqual(['danbooru:21', 'danbooru:22'])
    // The queue keeps running while the post page is open.
    release({ token: 'tok:21' })
    await settle()
    expect(api.createPost).toHaveBeenCalledTimes(1)

    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    router.back()
    await settle()
    expect(wrapper.find('.home-view').exists()).toBe(true)
    expect(cardLabels(wrapper)).toEqual(['Danbooru post 21', 'Danbooru post 22', 'Danbooru post 23'])
    expect(search).toHaveBeenCalledTimes(2)
    expect(globalThis.fetch.mock.calls.length).toBe(libraryFetches)
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 480, behavior: 'auto' })
    // danbooru:21 was imported (swapped for its library post), danbooru:22 is still selected and queued.
    expect(batchTitle(wrapper)).toBe('2 selected · 1 library · 1 remote')
    const statuses = wrapper.findAll('.import-card [data-status]').map((item) => item.attributes('data-status'))
    expect(statuses[0]).toBe('done')
    expect(['queued', 'checking', 'downloading', 'waiting']).toContain(statuses[1])
  })

  it('drops the kept home view, cancelling its queue, when the user goes anywhere else', async () => {
    const { wrapper, router } = await mountApp()
    await wrapper.get('.select-toggle').trigger('click')
    await section(wrapper).findAll('.remote-card')[0].trigger('click')
    await section(wrapper).findAll('.remote-card')[1].trigger('click')
    await wrapper.get('.import-card [data-test="start"]').trigger('click')
    await settle()

    await router.push({ name: 'booru-post', params: { site: 'danbooru', id: '11' } })
    await settle()
    expect(keepHome.value).toBe(true)
    await router.push('/tags')
    await settle()
    expect(keepHome.value).toBe(false)
    expect(useBooruPostContextStore().importer).toBeNull()
    release({ token: 'late' })
    await sleep(1600)
    await settle()
    // The in-flight item finishes; the queued one was cancelled with the home view.
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)

    await router.push('/')
    await settle()
    expect(wrapper.find('.import-card').exists()).toBe(false)
    expect(wrapper.findAll('.remote-card.selected')).toHaveLength(0)
  })
})
