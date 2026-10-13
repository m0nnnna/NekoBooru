// @vitest-environment jsdom
import AI_MODEL_REGISTRY from '../composables/aiModelRegistry.fixture.json'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// P4b: the Import card wired into the home
// view (section 4.4 of docs/booru-search-plan.md).
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
    search: async () => ({ posts: [1, 2, 3].map((id) => remotePost('danbooru', id)), nextCursor: null, total: 3 }),
  }
  return { adapters: { danbooru }, router: null }
})

vi.mock('../api/client', () => {
  const api = {
    getAutoTagSettings: vi.fn(async () => ({})),
    getAiModelDefaults: vi.fn(async () => ({ modelDefaults: {} })),
    getAutoTagRegistry: vi.fn(async () => AI_MODEL_REGISTRY),
    getPostAiAnalysis: vi.fn(async () => ({ results: [] })),
    bulkDeletePosts: vi.fn(async (ids) => ({ deleted: ids.length })),
    lookupInLibrary: vi.fn(async () => ({ found: {} })),
    getPools: vi.fn(async () => ({ results: [] })),
    fetchFromUrl: vi.fn(async ({ url }) => ({ token: `tok:${url}` })),
    getFromUrlProgress: vi.fn(async () => ({ received: 0, total: 0 })),
    createPost: vi.fn(),
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
import { api } from '../api/client'
import { useAuthStore } from '../stores/auth'

const POSTS = [5, 6].map((id) => ({
  id,
  extension: '.png',
  width: 100,
  height: 100,
  fileSize: 2048,
  safety: 'safe',
  tags: ['cat'],
  thumbUrl: `/thumb/${id}.webp`,
}))

async function mountHome({ sources = ['nekobooru', 'danbooru'] } = {}) {
  localStorage.setItem('nekobooru.remoteSources', JSON.stringify(sources))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: HomeView },
      { path: '/post/:id', name: 'post', component: { template: '<div />' } },
    ],
  })
  hoisted.router = router
  router.push('/')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { id: 1, username: 'neko', canBrowseBoorus: true }
  const wrapper = mount(HomeView, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const batchTitle = (wrapper) => wrapper.get('.batch-title').findAll('span').map((span) => span.text()).join(' ')
const remoteCards = (wrapper) => wrapper.get('.remote-section').findAll('.remote-card')
const startButton = (wrapper) => wrapper.get('.import-card [data-test="start"]')

async function selectRemote(wrapper, indexes, { library = [] } = {}) {
  await wrapper.get('.select-toggle').trigger('click')
  for (const index of library) await wrapper.findAll('.post-card')[index].trigger('click')
  for (const index of indexes) await remoteCards(wrapper)[index].trigger('click')
  await flushPromises()
}

// Lets the queue run: lookups, the 1.5 s gap between downloads, the saves.
async function drainQueue() {
  for (let i = 0; i < 6; i += 1) {
    await flushPromises()
    await sleep(0)
  }
}

describe('HomeView booru import', () => {
  let nextId

  beforeEach(() => {
    localStorage.clear()
    nextId = 42
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ results: POSTS, total: POSTS.length, pages: 1 }),
    }))
    api.lookupInLibrary.mockImplementation(async () => ({ found: {} }))
    api.createPost.mockImplementation(async (body) => ({ id: nextId++, tags: body.tags, safety: body.safety }))
    for (const name of ['fetchFromUrl', 'createPost', 'getPost', 'updatePost']) api[name].mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('swaps danbooru:1 for nekobooru:42 in the selection once it is imported', async () => {
    const wrapper = await mountHome()
    await selectRemote(wrapper, [0])
    expect(batchTitle(wrapper)).toBe('1 selected · 0 library · 1 remote')

    await startButton(wrapper).trigger('click')
    await drainQueue()

    expect(api.createPost).toHaveBeenCalledTimes(1)
    expect(api.createPost.mock.calls[0][0]).toMatchObject({ autoTag: false, source: 'https://danbooru.example/posts/1' })
    expect(batchTitle(wrapper)).toBe('1 selected · 1 library · 0 remote')
    // The new post heads page 1 (newest first) and is the selected one.
    expect(wrapper.findAll('.library-section .post-card.selected')).toHaveLength(1)
    // The booru card shows the "in library" badge and is no longer selected.
    expect(remoteCards(wrapper)[0].classes()).not.toContain('selected')
    expect(remoteCards(wrapper)[0].find('.library-badge').attributes('href')).toBe('/post/42')
    // The card stays to show the finished run.
    expect(wrapper.get('.import-card [data-status="done"]').text()).toContain('#42')
  })

  it('Start enqueues only the remote posts of a mixed selection', async () => {
    const wrapper = await mountHome()
    await selectRemote(wrapper, [0, 2], { library: [1] })
    expect(batchTitle(wrapper)).toBe('3 selected · 1 library · 2 remote')

    await startButton(wrapper).trigger('click')
    await sleep(1600)
    await drainQueue()

    expect(api.fetchFromUrl.mock.calls.map(([body]) => body.url)).toEqual([
      'https://cdn.danbooru.example/original/1.png',
      'https://cdn.danbooru.example/original/3.png',
    ])
    expect(wrapper.findAll('.import-card [data-status]')).toHaveLength(2)
    expect(batchTitle(wrapper)).toBe('3 selected · 3 library · 0 remote')
  })

  it('swaps posts already known to be in the library without enqueueing them', async () => {
    api.lookupInLibrary.mockImplementation(async (keys) => ({
      found: keys.includes('danbooru:2') ? { 'danbooru:2': { postId: 77 } } : {},
    }))
    const wrapper = await mountHome()
    await sleep(200)
    await flushPromises()
    await selectRemote(wrapper, [0, 1])

    await startButton(wrapper).trigger('click')
    // Swapped at once, before the queue reaches anything.
    expect(batchTitle(wrapper)).toBe('2 selected · 1 library · 1 remote')
    await drainQueue()

    expect(api.getPost).toHaveBeenCalledWith(77)
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)
    expect(api.fetchFromUrl.mock.calls[0][0].url).toBe('https://cdn.danbooru.example/original/1.png')
    expect(wrapper.findAll('.import-card [data-status]').map((item) => item.text())).toEqual([
      expect.stringContaining('Danbooru #1'),
    ])
    expect(batchTitle(wrapper)).toBe('2 selected · 2 library · 0 remote')
  })

  it('keeps an imported post that is not on the page current across batch tag edits', async () => {
    // The library is unticked, so post #42 lives only in the imported-posts
    // map; the per-post fallback must build each edit on the previous one.
    api.bulkUpdatePosts = vi.fn(async () => { throw new Error('Not Found') })
    const wrapper = await mountHome({ sources: ['danbooru'] })
    await selectRemote(wrapper, [0])
    await startButton(wrapper).trigger('click')
    await drainQueue()
    expect(batchTitle(wrapper)).toBe('1 selected · 1 library · 0 remote')
    api.updatePost.mockClear()

    const tagInput = wrapper.findComponent({ name: 'BulkTagCard' }).findComponent({ name: 'TagInput' })
    const apply = () => wrapper.findAll('.batch-actions-row button').find((b) => b.text().startsWith('Apply Tag')).trigger('click')
    tagInput.vm.$emit('update:modelValue', ['first'])
    await apply()
    await flushPromises()
    tagInput.vm.$emit('update:modelValue', ['second'])
    await apply()
    await flushPromises()

    expect(api.updatePost.mock.calls.map(([id]) => id)).toEqual([42, 42])
    expect(api.updatePost.mock.calls[1][1].tags).toEqual(expect.arrayContaining(['first', 'second']))
    delete api.bulkUpdatePosts
  })

  it('shows the import progress in the batch status strip', async () => {
    let release
    api.fetchFromUrl.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const wrapper = await mountHome()
    await selectRemote(wrapper, [0, 1])
    await startButton(wrapper).trigger('click')
    await drainQueue()

    const status = () => wrapper.get('.batch-status')
    expect(status().text()).toContain('Importing from boorus')
    expect(status().text()).toContain('0 of 2 imported')
    expect(status().classes()).toContain('running')

    release({ token: 'tok:1' })
    await drainQueue()
    await sleep(1600)
    await drainQueue()
    expect(status().text()).toContain('2 of 2 imported')
    expect(status().text()).toContain('100%')
    expect(status().classes()).toContain('success')
  })

  it('cancels the queue when the home view unmounts', async () => {
    let release
    api.fetchFromUrl.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const wrapper = await mountHome()
    await selectRemote(wrapper, [0, 1])
    await startButton(wrapper).trigger('click')
    await drainQueue()
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    release({ token: 'late' })
    await sleep(1600)
    await drainQueue()
    // The in-flight item finishes; the queued one is cancelled, not fetched.
    expect(api.fetchFromUrl).toHaveBeenCalledTimes(1)
    expect(api.createPost).toHaveBeenCalledTimes(1)
  })
})
