// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => {
  const api = {
    getAutoTagSettings: vi.fn(async () => ({ semanticModelId: 'qwen' })),
    getAutoTagStatus: vi.fn(async () => ({ enabled: true })),
    getAiModelDefaults: vi.fn(async () => ({ modelDefaults: { pixaiEnabled: true } })),
    getUploadJob: vi.fn(async () => null),
    autocomplete: vi.fn(async () => []),
  }
  return { api, default: api }
})

import UploadView from './UploadView.vue'

async function mountUpload() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/upload', component: UploadView },
      { path: '/post/:id', component: { template: '<div />' } },
    ],
  })
  router.push('/upload')
  await router.isReady()
  const wrapper = mount(UploadView, { global: { plugins: [createPinia(), router] } })
  await flushPromises()
  return wrapper
}

describe('UploadView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the drop zone, paste row and AI upload option', async () => {
    const wrapper = await mountUpload()
    expect(wrapper.get('h1').text()).toBe('Upload')
    expect(wrapper.get('.drop-zone').text()).toContain('Drop files here')
    expect(wrapper.get('.paste-btn').text()).toContain('Paste link or image')
    expect(wrapper.get('.upload-options').text()).toContain('Auto-tag new uploads')
    expect(wrapper.find('.upload-queue').exists()).toBe(false)
  })

  it('queues selected files with AI profiles and removes them again', async () => {
    const wrapper = await mountUpload()
    const input = wrapper.get('input[type="file"]')
    const file = new File(['abc'], 'cat.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')

    const queue = wrapper.get('.upload-queue')
    expect(queue.get('h2').text()).toBe('Queue (1 pending)')
    expect(queue.get('.filename').text()).toBe('cat.png')
    expect(queue.findAll('.ai-profile-btn').map((b) => b.text())).toEqual(['Anime / Booru', 'Realistic', 'Custom'])
    expect(queue.findAll('.queue-actions button').map((b) => b.text())).toEqual(['Clear All', 'Upload All (1)'])

    await queue.findAll('.upload-status button').find((b) => b.text() === 'Remove').trigger('click')
    expect(wrapper.find('.upload-queue').exists()).toBe(false)
  })
})
