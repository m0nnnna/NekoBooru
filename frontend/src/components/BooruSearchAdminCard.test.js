// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The booru-search client methods land with another package; mock the whole
// module so they exist here. Any other method (SettingsView's loaders) gets a
// promise that never settles, so the view mounts without real data.
const mocks = vi.hoisted(() => ({
  getBooruSearchSettings: null,
  updateBooruSearchSettings: null,
  getMe: null,
}))

vi.mock('../api/client', () => {
  const pending = new Map()
  const api = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined
      if (mocks[prop]) return mocks[prop]
      if (!pending.has(prop)) pending.set(prop, vi.fn(() => new Promise(() => {})))
      return pending.get(prop)
    },
  })
  return { api, default: api }
})

import BooruSearchAdminCard from './BooruSearchAdminCard.vue'
import SettingsView from '../views/SettingsView.vue'
import { useAuthStore } from '../stores/auth'

const ADMIN = { id: 1, username: 'admin', isAdmin: true }
const MEMBER = { id: 2, username: 'member', isAdmin: false }

function setUser(user) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const authStore = useAuthStore()
  authStore.user = user
  return { pinia, authStore }
}

async function mountCard(user = ADMIN) {
  const { pinia, authStore } = setUser(user)
  const wrapper = mount(BooruSearchAdminCard, { global: { plugins: [pinia] } })
  await flushPromises()
  return { wrapper, authStore }
}

function forbidden() {
  const error = new Error('Admin only')
  error.status = 403
  error.detail = 'Admin only'
  return error
}

describe('BooruSearchAdminCard', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.getBooruSearchSettings = vi.fn(async () => ({ enabled: false }))
    mocks.updateBooruSearchSettings = vi.fn(async (enabled) => ({ enabled }))
    mocks.getMe = vi.fn(async () => ({ ...ADMIN, canBrowseBoorus: true }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the current value from getBooruSearchSettings', async () => {
    mocks.getBooruSearchSettings = vi.fn(async () => ({ enabled: true }))
    const { wrapper } = await mountCard()

    expect(mocks.getBooruSearchSettings).toHaveBeenCalledTimes(1)
    const checkbox = wrapper.get('input[type="checkbox"]')
    expect(checkbox.element.checked).toBe(true)
    expect(checkbox.element.disabled).toBe(false)
    const text = wrapper.text()
    expect(text).toContain('Enable booru search')
    for (const site of ['Danbooru', 'Gelbooru', 'Safebooru', 'e621', 'Sankaku']) {
      expect(text).toContain(site)
    }
    expect(text).toContain('Off by default')
    expect(text).toContain('Gelbooru API credentials')
  })

  it('renders unchecked when the setting is off', async () => {
    const { wrapper } = await mountCard()

    expect(wrapper.get('input[type="checkbox"]').element.checked).toBe(false)
  })

  it('saves with updateBooruSearchSettings(true) and then refreshes the auth store', async () => {
    const { wrapper, authStore } = await mountCard()
    const fetchMe = vi.spyOn(authStore, 'fetchMe')

    const checkbox = wrapper.get('input[type="checkbox"]')
    await checkbox.setValue(true)
    await flushPromises()

    expect(mocks.updateBooruSearchSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateBooruSearchSettings).toHaveBeenCalledWith(true)
    expect(fetchMe).toHaveBeenCalledTimes(1)
    expect(mocks.updateBooruSearchSettings.mock.invocationCallOrder[0])
      .toBeLessThan(fetchMe.mock.invocationCallOrder[0])
    expect(authStore.user.canBrowseBoorus).toBe(true)
    expect(checkbox.element.checked).toBe(true)
    expect(wrapper.get('.cookies-status').classes()).toContain('success')
  })

  it('shows the error and reverts the checkbox on a 403', async () => {
    mocks.updateBooruSearchSettings = vi.fn(async () => { throw forbidden() })
    const { wrapper, authStore } = await mountCard()
    const fetchMe = vi.spyOn(authStore, 'fetchMe')

    const checkbox = wrapper.get('input[type="checkbox"]')
    await checkbox.setValue(true)
    await flushPromises()

    expect(mocks.updateBooruSearchSettings).toHaveBeenCalledWith(true)
    expect(fetchMe).not.toHaveBeenCalled()
    expect(checkbox.element.checked).toBe(false)
    const status = wrapper.get('.cookies-status')
    expect(status.classes()).toContain('error')
    expect(status.text()).toContain('Admin only')
  })

  it('renders nothing and loads nothing for a non-admin', async () => {
    const { wrapper } = await mountCard(MEMBER)

    expect(wrapper.find('.booru-search-admin-card').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(mocks.getBooruSearchSettings).not.toHaveBeenCalled()
  })
})

describe('SettingsView booru search card', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.getBooruSearchSettings = vi.fn(async () => ({ enabled: false }))
  })

  async function mountSettings(user) {
    const { pinia } = setUser(user)
    const wrapper = mount(SettingsView, { global: { plugins: [pinia] } })
    await flushPromises()
    return wrapper
  }

  it('is mounted for admins', async () => {
    const wrapper = await mountSettings(ADMIN)

    expect(wrapper.findComponent(BooruSearchAdminCard).exists()).toBe(true)
    expect(wrapper.text()).toContain('Enable booru search')
    wrapper.unmount()
  })

  it('is never shown to non-admins', async () => {
    const wrapper = await mountSettings(MEMBER)

    expect(wrapper.findComponent(BooruSearchAdminCard).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Enable booru search')
    expect(mocks.getBooruSearchSettings).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
