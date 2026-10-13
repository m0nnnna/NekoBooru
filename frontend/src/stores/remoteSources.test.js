// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakeRouter = vi.hoisted(() => {
  const router = {
    currentRoute: { value: { name: 'home', query: {} } },
    replace: null,
  }
  return router
})

vi.mock('../router', () => ({ default: fakeRouter }))

import { LAYOUT_STORAGE_KEY, SOURCES_STORAGE_KEY, useRemoteSourcesStore } from './remoteSources.js'

function freshStore(query = {}) {
  fakeRouter.currentRoute.value = { name: 'home', query }
  setActivePinia(createPinia())
  return useRemoteSourcesStore()
}

describe('useRemoteSourcesStore', () => {
  beforeEach(() => {
    localStorage.clear()
    fakeRouter.replace = vi.fn(async ({ query }) => {
      fakeRouter.currentRoute.value = { ...fakeRouter.currentRoute.value, query }
    })
  })

  it('starts with only the library ticked, grouped', () => {
    const store = freshStore()
    expect(store.sources).toEqual(['nekobooru'])
    expect(store.layout).toBe('grouped')
    expect(store.libraryTicked).toBe(true)
    expect(store.remoteSites).toEqual([])
    expect(store.toRouteQuery()).toEqual({ sources: undefined, layout: undefined })
  })

  it('keeps ticks in SOURCE_IDS order and never unticks the last source', () => {
    const store = freshStore()
    expect(store.toggle('sankaku')).toBe(true)
    expect(store.toggle('danbooru')).toBe(true)
    expect(store.sources).toEqual(['nekobooru', 'danbooru', 'sankaku'])
    expect(store.remoteSites).toEqual(['danbooru', 'sankaku'])
    expect(store.toggle('nekobooru')).toBe(true)
    expect(store.toggle('danbooru')).toBe(true)
    expect(store.sources).toEqual(['sankaku'])
    expect(store.toggle('sankaku')).toBe(false)
    expect(store.sources).toEqual(['sankaku'])
    expect(store.toggle('pixiv')).toBe(false)
    expect(store.setSources(['bogus'])).toBe(false)
    expect(store.setSources(['gelbooru', 'gelbooru', 'nekobooru'])).toBe(true)
    expect(store.sources).toEqual(['nekobooru', 'gelbooru'])
  })

  it('writes every change to localStorage and replaces the route query', async () => {
    const store = freshStore({ q: 'cat', page: '2' })
    store.toggle('danbooru')
    store.setLayout('interleaved')
    await Promise.resolve()
    expect(JSON.parse(localStorage.getItem(SOURCES_STORAGE_KEY))).toEqual(['nekobooru', 'danbooru'])
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('interleaved')
    expect(fakeRouter.replace).toHaveBeenLastCalledWith({ query: { q: 'cat', page: '2', sources: 'nekobooru,danbooru', layout: 'interleaved' } })
    expect(store.toRouteQuery()).toEqual({ sources: 'nekobooru,danbooru', layout: 'interleaved' })

    store.toggle('danbooru')
    store.setLayout('grouped')
    expect(fakeRouter.currentRoute.value.query).toEqual({ q: 'cat', page: '2' })
    expect(store.setLayout('mosaic')).toBe(false)
  })

  it('leaves the query of any route but home alone', async () => {
    const store = freshStore()
    fakeRouter.currentRoute.value = { name: 'settings', query: { tab: 'ai' } }
    expect(store.toggle('danbooru')).toBe(true)
    store.setLayout('interleaved')
    await Promise.resolve()
    expect(fakeRouter.replace).not.toHaveBeenCalled()
    expect(fakeRouter.currentRoute.value.query).toEqual({ tab: 'ai' })
    // The choice is still kept for when the home view next reads it.
    expect(JSON.parse(localStorage.getItem(SOURCES_STORAGE_KEY))).toEqual(['nekobooru', 'danbooru'])
  })

  it('restores from localStorage when the URL says nothing', () => {
    localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(['e621', 'nope', 'nekobooru']))
    localStorage.setItem(LAYOUT_STORAGE_KEY, 'interleaved')
    const store = freshStore()
    expect(store.sources).toEqual(['nekobooru', 'e621'])
    expect(store.layout).toBe('interleaved')
    store.fromRoute({ q: 'cat' })
    expect(store.sources).toEqual(['nekobooru', 'e621'])
    // The URL is brought in line so the view can be shared.
    expect(fakeRouter.replace).toHaveBeenCalledWith({ query: { sources: 'nekobooru,e621', layout: 'interleaved' } })
  })

  it('lets the URL win over storage, dropping invalid ids', () => {
    localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(['nekobooru', 'e621']))
    const store = freshStore()
    fakeRouter.currentRoute.value = { name: 'home', query: { sources: 'gelbooru,bogus,danbooru', layout: 'interleaved' } }
    store.fromRoute(fakeRouter.currentRoute.value.query)
    expect(store.sources).toEqual(['danbooru', 'gelbooru'])
    expect(store.layout).toBe('interleaved')
    expect(JSON.parse(localStorage.getItem(SOURCES_STORAGE_KEY))).toEqual(['danbooru', 'gelbooru'])
    // The URL already matches apart from order; it is normalised once.
    expect(fakeRouter.replace).toHaveBeenCalledWith({ query: { sources: 'danbooru,gelbooru', layout: 'interleaved' } })

    store.fromRoute({ sources: 'bogus' })
    expect(store.sources).toEqual(['danbooru', 'gelbooru'])
    store.fromRoute({ sources: ['sankaku', 'nekobooru'], layout: 'grouped' })
    expect(store.sources).toEqual(['nekobooru', 'sankaku'])
    expect(store.layout).toBe('grouped')
  })

  it('round-trips toRouteQuery through fromRoute', () => {
    const store = freshStore()
    store.setSources(['nekobooru', 'safebooru', 'e621'])
    store.setLayout('interleaved')
    const query = store.toRouteQuery()
    localStorage.clear()
    const other = freshStore()
    other.fromRoute(query)
    expect(other.sources).toEqual(store.sources)
    expect(other.layout).toBe(store.layout)
  })

  it('works without localStorage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      const store = freshStore()
      expect(store.sources).toEqual(['nekobooru'])
      expect(store.toggle('danbooru')).toBe(true)
      expect(store.sources).toEqual(['nekobooru', 'danbooru'])
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})
