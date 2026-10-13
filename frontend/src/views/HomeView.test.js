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
      { path: '/', component: HomeView },
      { path: '/post/:id', component: { template: '<div />' } },
    ],
  })
  router.push('/')
  await router.isReady()
  const wrapper = mount(HomeView, { global: { plugins: [createPinia(), router] } })
  await flushPromises()
  return wrapper
}

describe('HomeView batch panel', () => {
  beforeEach(() => {
    localStorage.clear()
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ results: POSTS, total: POSTS.length, pages: 1 }),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens from Select, selects the page, docks right, and clears on Done', async () => {
    const wrapper = await mountHome()
    expect(wrapper.text()).toContain('3 posts found')
    expect(wrapper.find('.batch-panel').exists()).toBe(false)

    await wrapper.get('.select-toggle').trigger('click')
    const panel = wrapper.get('.batch-panel')
    expect(panel.classes()).toContain('dock-bottom')
    expect(wrapper.findAll('.batch-card')).toHaveLength(5)

    const headerButton = (label) => panel.findAll('.batch-header button').find((b) => b.text() === label)
    await headerButton('Select page').trigger('click')
    expect(panel.get('.batch-header strong').text()).toBe('3')
    expect(wrapper.findAll('.post-card.selected')).toHaveLength(3)

    await headerButton('Right').trigger('click')
    expect(wrapper.get('.batch-panel').classes()).toContain('dock-right')
    expect(localStorage.getItem('nekobooru.batchPanelDock')).toBe('right')

    await headerButton('Done').trigger('click')
    expect(wrapper.find('.batch-panel').exists()).toBe(false)
    await wrapper.get('.select-toggle').trigger('click')
    expect(wrapper.get('.batch-header strong').text()).toBe('0')
  })

  it('deletes the selection from the header after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { api } = await import('../api/client')
    const wrapper = await mountHome()
    await wrapper.get('.select-toggle').trigger('click')
    const deleteButton = () => wrapper.findAll('.batch-header button').find((b) => b.text() === 'Delete')
    expect(deleteButton().attributes('disabled')).toBeDefined()

    await wrapper.findAll('.post-card')[1].trigger('click')
    expect(deleteButton().attributes('disabled')).toBeUndefined()
    await deleteButton().trigger('click')
    await flushPromises()
    expect(api.bulkDeletePosts).toHaveBeenCalledWith([2])
    expect(wrapper.get('.batch-status').text()).toContain('Deleted 1 selected post(s).')
  })
})
