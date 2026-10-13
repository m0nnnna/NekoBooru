// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const POST = {
  id: 7,
  filename: 'cat.png',
  extension: '.png',
  width: 640,
  height: 480,
  fileSize: 2048,
  safety: 'safe',
  tags: ['cat'],
  tagDetails: [{ name: 'cat', category: 'general', usageCount: 4 }],
  contentUrl: '/content/7.png',
  createdAt: '2026-01-02T03:04:05Z',
  isFavorited: false,
}

vi.mock('../api/client', () => {
  const api = {
    getPost: vi.fn(async () => structuredClone(POST)),
    getPostNeighbors: vi.fn(async () => ({ prev: null, next: 8 })),
    getPools: vi.fn(async () => ({ results: [{ id: 1, name: 'Favourites' }] })),
    getAutoTagSettings: vi.fn(async () => ({ semanticModelId: 'qwen' })),
    getAutoTagStatus: vi.fn(async () => ({ enabled: true, models: [] })),
    getAiModelDefaults: vi.fn(async () => ({ modelDefaults: {} })),
    getPostAiAnalysis: vi.fn(async () => ({
      results: [{ id: 3, modelName: 'Qwen', profile: 'anime', description: 'A cat on a sofa.', semanticTags: ['cozy'] }],
    })),
    getComments: vi.fn(async () => []),
    autocomplete: vi.fn(async () => [{ name: 'new_tag', usageCount: 3, categoryColor: '#fff' }]),
    updatePost: vi.fn(async () => ({})),
  }
  return { api, default: api }
})

import PostView from './PostView.vue'

async function mountPost() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/post/:id', name: 'post', component: PostView },
      { path: '/settings', component: { template: '<div />' } },
      { path: '/tags', component: { template: '<div />' } },
    ],
  })
  router.push('/post/7')
  await router.isReady()
  const wrapper = mount(PostView, { global: { plugins: [createPinia(), router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('PostView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('renders the media, info, semantic description, tags, actions and tools', async () => {
    const wrapper = await mountPost()
    expect(wrapper.find('.media-container').exists()).toBe(true)
    expect(wrapper.find('.nav-next').exists()).toBe(true)
    expect(wrapper.find('.nav-prev').exists()).toBe(false)
    expect(wrapper.get('.post-info-id').text()).toContain('#7')
    expect(wrapper.get('.post-info-meta').text()).toContain('640 × 480')
    expect(wrapper.get('.post-info-meta').text()).toContain('2.0 KB')
    expect(wrapper.get('.semantic-description-card').text()).toContain('A cat on a sofa.')
    expect(wrapper.findAll('.sidebar-section h3').map((h) => h.text())).toEqual(['Semantic Description', 'Tags'])
    expect(wrapper.get('.actions').text()).toContain('Add to Pool')
    expect(wrapper.findAll('.post-tools-tab').map((b) => b.text())).toEqual(['AI Tags', 'Similar', 'Search', 'Optimize'])
    expect(wrapper.get('.post-tools-tab.active').text()).toBe('Similar')

    await wrapper.findAll('.post-tools-tab').find((b) => b.text() === 'Optimize').trigger('click')
    expect(wrapper.get('.post-tools-tab.active').text()).toBe('Optimize')
    expect(wrapper.get('.post-optimize-summary').text()).toContain('Media Optimizer')
    expect(wrapper.get('.ai-profile-actions').text()).toContain('Anime / Booru')
  })

  it('edits tags in the raw editor with autocomplete and saves them', async () => {
    const { api } = await import('../api/client')
    const wrapper = await mountPost()
    await wrapper.get('.edit-tags-btn').trigger('click')
    expect(wrapper.get('.modal h2').text()).toBe('Edit Tags')
    expect(wrapper.get('.tag-editor-count').text()).toBe('1 tags')

    await wrapper.findAll('.segmented-control button').find((b) => b.text() === 'Text').trigger('click')
    const textarea = wrapper.get('.raw-tag-editor textarea')
    expect(textarea.element.value).toBe('cat')
    await textarea.setValue('cat\nne')
    textarea.element.setSelectionRange(6, 6)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await flushPromises()
    expect(api.autocomplete).toHaveBeenCalledWith('ne', expect.objectContaining({ includeRemote: true }))

    await wrapper.get('.raw-tag-suggestions li').trigger('mousedown')
    expect(textarea.element.value).toBe('cat\nnew_tag')

    await wrapper.findAll('.modal-actions button').find((b) => b.text() === 'Save').trigger('click')
    await flushPromises()
    expect(api.updatePost).toHaveBeenCalledWith(7, { tags: ['cat', 'new_tag'], tagCategories: {}, tagDisplayNames: {} })
    expect(wrapper.find('.raw-tag-editor').exists()).toBe(false)
  })
})
