// @vitest-environment jsdom
import AI_MODEL_REGISTRY from '../composables/aiModelRegistry.fixture.json'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  const remotePost = (site, id, extra = {}) => ({
    key: `${site}:${id}`,
    site,
    id: String(id),
    postUrl: `https://${site}.example/posts/${id}`,
    thumbUrl: `https://cdn.${site}.example/thumb/${id}.jpg`,
    sampleUrl: null,
    fileUrl: `https://cdn.${site}.example/original/${id}.png`,
    width: 800,
    height: 600,
    fileExt: 'png',
    mediaType: 'image',
    fileSize: 1000,
    safety: 'safe',
    rawRating: 'g',
    tags: ['cat_ears', 'miyu_(blue_archive)'],
    tagCategories: { cat_ears: 'general', 'miyu_(blue_archive)': 'character' },
    tagDisplayNames: {},
    source: null,
    unavailable: null,
    referer: `https://${site}.example/`,
    ...extra,
  })
  // Danbooru: two pages of three; Sankaku: pages of two and one, mixed-case
  // ids, an estimated total.
  const danbooru = {
    id: 'danbooru',
    translate: () => ({ ignored: ['score:>5'], note: null }),
    search: async ({ cursor }) => (cursor === null
      ? { posts: [7, 8, 9].map((id) => remotePost('danbooru', id)), nextCursor: 2, total: 40 }
      : { posts: [10, 11, 12].map((id) => remotePost('danbooru', id)), nextCursor: null, total: 40 }),
  }
  const sankaku = {
    id: 'sankaku',
    translate: () => ({ ignored: [], note: null }),
    search: async ({ cursor }) => (cursor === null
      ? { posts: ['AbC', 'XyZ'].map((id) => remotePost('sankaku', id)), nextCursor: 'n2', total: 40, totalIsEstimate: true }
      : { posts: [remotePost('sankaku', 'Q1')], nextCursor: null }),
  }
  return { remotePost, adapters: { danbooru, sankaku }, router: null }
})

vi.mock('../api/client', () => {
  const api = {
    getAutoTagSettings: vi.fn(async () => ({})),
    getAiModelDefaults: vi.fn(async () => ({ modelDefaults: {} })),
    getAutoTagRegistry: vi.fn(async () => AI_MODEL_REGISTRY),
    getPostAiAnalysis: vi.fn(async () => ({ results: [] })),
    bulkDeletePosts: vi.fn(async (ids) => ({ deleted: ids.length })),
    lookupInLibrary: vi.fn(async () => ({ found: {} })),
  }
  return { api, default: api }
})
// The source store writes ?sources through the app router; point it at the
// router of the mounted test.
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
import { api } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { useBooruPostContextStore } from '../stores/booruPostContext'

const POSTS = [1, 2, 3].map((id) => ({
  id,
  extension: '.png',
  width: 100,
  height: 100,
  fileSize: 2048,
  safety: 'safe',
  tags: ['cat'],
  thumbUrl: `/thumb/${id}.webp`,
}))

// Library post 3 was imported from Danbooru #9 and Sankaku #AbC (whose id
// tag the library stores lower-cased).
const POSTS_WITH_ID_TAGS = POSTS.map((post) => (post.id === 3 ? { ...post, tags: ['cat', 'danbooru_9', 'sankaku_abc'] } : post))

let libraryPosts = POSTS

async function mountHome({ canBrowseBoorus = false, sources = null, layout = null } = {}) {
  if (sources) localStorage.setItem('nekobooru.remoteSources', JSON.stringify(sources))
  if (layout) localStorage.setItem('nekobooru.remoteLayout', layout)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: HomeView },
      { path: '/post/:id', name: 'post', component: { template: '<div />' } },
      { path: '/booru/:site/:id', name: 'booru-post', component: { template: '<div />' } },
    ],
  })
  hoisted.router = router
  router.push('/')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { id: 1, username: 'neko', canBrowseBoorus }
  const wrapper = mount(HomeView, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router, pinia }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const batchTitle = (wrapper) => wrapper.get('.batch-title').findAll('span').map((span) => span.text()).join(' ')
const remoteKeys = (root) => root.findAll('.remote-card').map((card) => card.attributes('aria-label'))

describe('HomeView with booru search switched off', () => {
  beforeEach(() => {
    localStorage.clear()
    libraryPosts = POSTS
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ results: libraryPosts, total: libraryPosts.length, pages: 1 }),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  // The snapshots were recorded from main before P3b: with the switch off the
  // home view's DOM must not change at all.
  it('renders the same home view DOM as before booru search', async () => {
    const { wrapper } = await mountHome()
    expect(wrapper.get('.home-view').html()).toMatchSnapshot()
  })

  it('renders the same batch panel DOM as before booru search', async () => {
    const { wrapper } = await mountHome()
    await wrapper.get('.select-toggle').trigger('click')
    const panel = wrapper.get('.batch-panel')
    await panel.findAll('.batch-header button').find((b) => b.text() === 'Select page').trigger('click')
    expect(wrapper.get('.home-view').html()).toMatchSnapshot()
  })

  it('ignores saved booru sources and leaves the URL alone', async () => {
    const baseline = (await mountHome()).wrapper.get('.home-view').html()
    document.body.innerHTML = ''
    const { wrapper, router } = await mountHome({ sources: ['danbooru'], layout: 'interleaved' })
    expect(wrapper.get('.home-view').html()).toBe(baseline)
    expect(router.currentRoute.value.query).toEqual({})
    expect(globalThis.fetch.mock.calls[0][0]).toContain('&limit=42&')
  })
})

describe('HomeView with booru search switched on', () => {
  beforeEach(() => {
    localStorage.clear()
    libraryPosts = POSTS_WITH_ID_TAGS
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ results: libraryPosts, total: libraryPosts.length, pages: 1 }),
    }))
    api.lookupInLibrary.mockImplementation(async () => ({ found: {} }))
    api.bulkDeletePosts.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('with only NekoBooru ticked renders no booru section and the same grid', async () => {
    libraryPosts = POSTS
    const off = (await mountHome()).wrapper.get('.post-grid').html()
    document.body.innerHTML = ''
    const { wrapper } = await mountHome({ canBrowseBoorus: true })
    expect(wrapper.find('.booru-results').exists()).toBe(false)
    expect(wrapper.find('.remote-section').exists()).toBe(false)
    expect(wrapper.get('.post-grid').html()).toBe(off)
    // The per-page dropdown offers "Default", selected out of the box; the
    // library still asks for 42.
    const select = wrapper.get('select[aria-label="Posts per page"]')
    expect(select.findAll('option')[0].text()).toBe('Default per page')
    expect(select.element.value).toBe('default')
    expect(globalThis.fetch.mock.calls[0][0]).toContain('&limit=42&')
  })

  it('shows a Danbooru section with page counts, badges and page navigation', async () => {
    const search = vi.spyOn(hoisted.adapters.danbooru, 'search')
    api.lookupInLibrary.mockImplementation(async () => ({ found: { 'danbooru:8': { postId: 77 } } }))
    const { wrapper, router } = await mountHome({ canBrowseBoorus: true, sources: ['nekobooru', 'danbooru'] })
    expect(router.currentRoute.value.query).toEqual({ sources: 'nekobooru,danbooru' })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][0]).toMatchObject({ cursor: null, limit: null, query: '' })

    expect(wrapper.get('.library-section-header').text()).toContain('NekoBooru')
    const section = wrapper.get('.remote-section')
    expect(section.get('h2').text()).toBe('Danbooru')
    expect(section.get('.section-count').text()).toBe('3 of 40 posts')
    expect(section.get('.section-pages').text()).toBe('· page 1 of 2')
    expect(section.text()).toContain('Ignored here: score:>5')
    expect(remoteKeys(section)).toEqual(['Danbooru post 7', 'Danbooru post 8', 'Danbooru post 9'])
    // #9 is on the library page (its danbooru_9 tag); #8 comes from the lookup.
    await sleep(200)
    await flushPromises()
    const badges = section.findAll('.library-badge').map((badge) => badge.attributes('href'))
    expect(badges).toEqual(['/post/77', '/post/3'])

    const nav = () => section.get('.remote-section-footer').findAll('button')
    expect(nav().map((button) => button.attributes('disabled') !== undefined)).toEqual([true, false])
    await nav()[1].trigger('click')
    await flushPromises()
    expect(search.mock.calls[1][0]).toMatchObject({ cursor: 2 })
    // Page 2 replaces page 1.
    expect(remoteKeys(section)).toEqual(['Danbooru post 10', 'Danbooru post 11', 'Danbooru post 12'])
    expect(section.get('.section-pages').text()).toBe('· page 2 of 2')
    expect(nav().map((button) => button.attributes('disabled') !== undefined)).toEqual([false, true])

    // Back to page 1 from the cache, badges intact.
    await nav()[0].trigger('click')
    await flushPromises()
    expect(search).toHaveBeenCalledTimes(2)
    expect(remoteKeys(section)).toEqual(['Danbooru post 7', 'Danbooru post 8', 'Danbooru post 9'])
    expect(section.findAll('.library-badge')).toHaveLength(2)
  })

  it('selects library and booru posts together; library tools only see library posts', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { wrapper } = await mountHome({ canBrowseBoorus: true, sources: ['nekobooru', 'danbooru'] })
    const card = wrapper.findAll('.remote-card')[0]
    await card.trigger('pointerdown', { button: 0 })
    await sleep(600)
    await card.trigger('pointerup')
    await card.trigger('click')
    await flushPromises()
    expect(batchTitle(wrapper)).toBe('1 selected · 0 library · 1 remote')
    const deleteButton = () => wrapper.findAll('.batch-header button').find((b) => b.text() === 'Delete')
    expect(deleteButton().attributes('disabled')).toBeDefined()

    await wrapper.findAll('.post-card')[1].trigger('click')
    // Shift-click in another section is a plain toggle, not a range.
    await wrapper.findAll('.remote-card')[2].trigger('click', { shiftKey: true })
    expect(batchTitle(wrapper)).toBe('3 selected · 1 library · 2 remote')
    expect(wrapper.findAll('.remote-card.selected')).toHaveLength(2)
    // A shift-click inside the same section selects the range.
    await wrapper.findAll('.post-card')[0].trigger('click')
    await wrapper.findAll('.post-card')[2].trigger('click', { shiftKey: true })
    expect(batchTitle(wrapper)).toBe('5 selected · 3 library · 2 remote')

    await deleteButton().trigger('click')
    await flushPromises()
    expect(api.bulkDeletePosts).toHaveBeenCalledWith([2, 1, 3])
    // The booru posts stay selected.
    expect(batchTitle(wrapper)).toBe('2 selected · 0 library · 2 remote')
  })

  it('opens booru posts on the booru post page with their section for Prev / Next', async () => {
    const { wrapper, router } = await mountHome({ canBrowseBoorus: true, sources: ['nekobooru', 'danbooru', 'sankaku'] })
    await wrapper.findAll('.remote-section')[1].findAll('.remote-card')[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/booru/sankaku/AbC')
    const context = useBooruPostContextStore()
    expect(context.posts.map((post) => post.key)).toEqual(['sankaku:AbC', 'sankaku:XyZ'])
    expect(context.neighbours('sankaku:AbC')).toMatchObject({ prev: null, next: { key: 'sankaku:XyZ' } })
    expect(document.body.querySelector('.remote-viewer')).toBeNull()
  })

  it('interleaves the boorus after the library page and hides posts it already has', async () => {
    const { wrapper } = await mountHome({
      canBrowseBoorus: true,
      sources: ['nekobooru', 'danbooru', 'sankaku'],
      layout: 'interleaved',
    })
    const grid = wrapper.get('.mixed-grid')
    expect(grid.findAll('.post-card')).toHaveLength(3)
    // Round-robin, minus danbooru #9 and sankaku #AbC (tagged sankaku_abc).
    expect(remoteKeys(grid)).toEqual(['Danbooru post 7', 'Danbooru post 8', 'Sankaku post XyZ'])
    expect(wrapper.find('.remote-section').exists()).toBe(false)
    const strip = wrapper.get('.source-strip').text()
    expect(strip).toContain('2 of ~40 posts')
    expect(strip).toContain('page 1 of ~2')

    const next = () => wrapper.get('.feed-footer').findAll('button')[1]
    await next().trigger('click')
    await flushPromises()
    // Every source steps to its page 2, which replaces its page 1.
    expect(remoteKeys(wrapper.get('.mixed-grid'))).toEqual([
      'Danbooru post 10', 'Sankaku post Q1', 'Danbooru post 11', 'Danbooru post 12',
    ])
    expect(wrapper.get('.feed-footer').text()).toContain('Page 2')
    expect(next().attributes('disabled')).toBeDefined()
  })

  it('applies a numeric page size to the boorus as well', async () => {
    const search = vi.spyOn(hoisted.adapters.danbooru, 'search')
    localStorage.setItem('postsPerPage', '60')
    await mountHome({ canBrowseBoorus: true, sources: ['nekobooru', 'danbooru'] })
    expect(globalThis.fetch.mock.calls[0][0]).toContain('&limit=60&')
    expect(search.mock.calls[0][0]).toMatchObject({ limit: 60 })
  })
})
