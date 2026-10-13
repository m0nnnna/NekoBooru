// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  status: { enabled: true, gelbooruConfigured: true, sources: [] },
  router: {
    currentRoute: { value: { name: 'home', query: {} } },
    replace: null,
  },
}))

vi.mock('../../api/client', () => {
  const api = { getBooruSearchStatus: vi.fn(async () => mocks.status) }
  return { api, default: api }
})
vi.mock('../../router', () => ({ default: mocks.router }))

import SourcePicker from './SourcePicker.vue'
import { api } from '../../api/client'
import { useAuthStore } from '../../stores/auth'
import { useRemoteSourcesStore } from '../../stores/remoteSources'

async function mountPicker({ canBrowseBoorus = true } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { id: 1, username: 'neko', canBrowseBoorus }
  const wrapper = mount(SourcePicker, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

function optionRows(wrapper) {
  return wrapper.findAll('.source-option').map((row) => ({
    label: row.get('.source-name').text(),
    checked: row.get('input').element.checked,
    disabled: row.get('input').element.disabled,
  }))
}

describe('SourcePicker', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.status = { enabled: true, gelbooruConfigured: true, sources: [] }
    mocks.router.currentRoute.value = { name: 'home', query: {} }
    mocks.router.replace = vi.fn(async ({ query }) => {
      mocks.router.currentRoute.value = { ...mocks.router.currentRoute.value, query }
    })
    api.getBooruSearchStatus.mockClear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders nothing, and asks nothing, without canBrowseBoorus', async () => {
    const wrapper = await mountPicker({ canBrowseBoorus: false })
    expect(wrapper.find('.source-picker').exists()).toBe(false)
    expect(wrapper.html()).toBe('<!--v-if-->')
    expect(api.getBooruSearchStatus).not.toHaveBeenCalled()
  })

  it('lists the six sources with only NekoBooru ticked out of the box', async () => {
    const wrapper = await mountPicker()
    expect(wrapper.get('.source-button').text()).toContain('NekoBooru')
    await wrapper.get('.source-button').trigger('click')
    expect(optionRows(wrapper)).toEqual([
      { label: 'NekoBooru', checked: true, disabled: true },
      { label: 'Danbooru', checked: false, disabled: false },
      { label: 'e621 / e926', checked: false, disabled: false },
      { label: 'Sankaku', checked: false, disabled: false },
      { label: 'Gelbooru', checked: false, disabled: false },
      { label: 'Safebooru', checked: false, disabled: false },
    ])
    expect(api.getBooruSearchStatus).toHaveBeenCalledTimes(1)
  })

  it('writes ticks and the layout to the store, storage and URL', async () => {
    const wrapper = await mountPicker()
    const store = useRemoteSourcesStore()
    await wrapper.get('.source-button').trigger('click')
    const danbooru = wrapper.findAll('.source-option')[1].get('input')
    danbooru.element.checked = true
    await danbooru.trigger('change')
    expect(store.sources).toEqual(['nekobooru', 'danbooru'])
    expect(JSON.parse(localStorage.getItem('nekobooru.remoteSources'))).toEqual(['nekobooru', 'danbooru'])
    expect(mocks.router.currentRoute.value.query).toEqual({ sources: 'nekobooru,danbooru' })
    expect(wrapper.get('.source-label').text()).toBe('NekoBooru +1')

    await wrapper.get('input[value="interleaved"]').trigger('change')
    expect(store.layout).toBe('interleaved')
    expect(mocks.router.currentRoute.value.query.layout).toBe('interleaved')

    // NekoBooru can be unticked now that another source is ticked.
    expect(optionRows(wrapper)[0].disabled).toBe(false)
  })

  it('gives every booru row safe / sketchy / explicit toggles that narrow that booru only', async () => {
    const wrapper = await mountPicker()
    const store = useRemoteSourcesStore()
    await wrapper.get('.source-button').trigger('click')
    const rows = wrapper.findAll('.source-row')
    expect(rows[0].find('.rating-toggles').exists()).toBe(false) // NekoBooru follows the global filter
    expect(rows.slice(1).map((row) => row.findAll('.rating-toggle').length)).toEqual([3, 3, 3, 3, 3])

    const e621 = rows[2].findAll('.rating-toggle')
    expect(e621.map((button) => button.attributes('aria-pressed'))).toEqual(['true', 'true', 'true'])
    expect(e621[2].attributes('aria-label')).toBe('e621 / e926: hide explicit')
    expect(e621[2].element.tagName).toBe('BUTTON') // focusable, Enter/Space click it

    await e621[2].trigger('click')
    expect(store.siteRatings('e621')).toEqual({ safe: true, sketchy: true, unsafe: false })
    expect(store.siteRatings('danbooru').unsafe).toBe(true)
    const after = wrapper.findAll('.source-row')[2].findAll('.rating-toggle')[2]
    expect(after.attributes('aria-pressed')).toBe('false')
    expect(after.attributes('aria-label')).toBe('e621 / e926: show explicit')
    expect(after.classes()).not.toContain('active')
    expect(mocks.router.currentRoute.value.query.ratings).toBe('e621:sq')
  })

  it('greys Gelbooru out when the server has no API key', async () => {
    mocks.status = { enabled: true, gelbooruConfigured: false, sources: [] }
    const wrapper = await mountPicker()
    await wrapper.get('.source-button').trigger('click')
    const gelbooru = wrapper.findAll('.source-option')[4]
    expect(gelbooru.get('input').element.disabled).toBe(true)
    expect(gelbooru.text()).toContain('needs an API key in Settings')
  })

  it('closes on Escape and on a click outside', async () => {
    const wrapper = await mountPicker()
    await wrapper.get('.source-button').trigger('click')
    expect(wrapper.find('.source-menu').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.source-menu').exists()).toBe(false)

    await wrapper.get('.source-button').trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('.source-menu').exists()).toBe(false)
  })
})
