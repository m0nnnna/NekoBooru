// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => {
  const api = {
    getAutoTagSettings: vi.fn(async () => ({})),
    getAiModelDefaults: vi.fn(async () => ({ modelDefaults: {} })),
    getPostAiAnalysis: vi.fn(async () => ({ results: [] })),
    bulkDeletePosts: vi.fn(async (ids) => ({ deleted: ids.length })),
    lookupInLibrary: vi.fn(async () => ({ found: {} })),
  }
  return { api, default: api }
})

import HomeView from './HomeView.vue'

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

async function mountHome() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: HomeView },
      { path: '/post/:id', name: 'post', component: { template: '<div />' } },
    ],
  })
  router.push('/')
  await router.isReady()
  const pinia = createPinia()
  const wrapper = mount(HomeView, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router, pinia }
}

describe('HomeView with booru search switched off', () => {
  beforeEach(() => {
    localStorage.clear()
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ results: POSTS, total: POSTS.length, pages: 1 }),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
})
