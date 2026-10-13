// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: {} }))
vi.mock('../api/client', () => ({ api: mocks.api, default: mocks.api }))

import { useAuthStore } from './auth.js'

const BARE = { id: 1, username: 'neko', isAdmin: true }

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.api.login = vi.fn(async () => BARE)
    mocks.api.bootstrapAdmin = vi.fn(async () => BARE)
    mocks.api.getMe = vi.fn(async () => ({ ...BARE, canBrowseBoorus: true }))
  })

  it('reads canBrowseBoorus from /me right after logging in', async () => {
    const store = useAuthStore()
    expect(store.canBrowseBoorus).toBe(false)
    await store.login('neko', 'pw')
    expect(mocks.api.getMe).toHaveBeenCalledTimes(1)
    expect(store.canBrowseBoorus).toBe(true)
    expect(store.isAuthenticated).toBe(true)
  })

  it('stays signed in without capabilities when /me fails', async () => {
    mocks.api.getMe = vi.fn(async () => { throw new Error('offline') })
    const store = useAuthStore()
    await store.bootstrapAdmin('neko', 'pw')
    expect(store.user).toEqual(BARE)
    expect(store.canBrowseBoorus).toBe(false)
  })

  it('only treats an explicit true as the capability', () => {
    const store = useAuthStore()
    store.user = { ...BARE, canBrowseBoorus: 'yes' }
    expect(store.canBrowseBoorus).toBe(false)
  })
})
