// @vitest-environment jsdom
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

const thumbHooks = vi.hoisted(() => ({ thumbExpired: vi.fn(() => false), refreshThumb: vi.fn(async () => null) }))
vi.mock('../../remote/adapters/index.js', () => ({
  adapterFor: (site) => (site === 'sankaku' ? thumbHooks : { id: site }),
}))

import RemotePostCard from './RemotePostCard.vue'

const POST = {
  key: 'danbooru:123',
  site: 'danbooru',
  id: '123',
  postUrl: 'https://danbooru.donmai.us/posts/123',
  thumbUrl: 'https://cdn.donmai.us/360x360/ab/cd/abcd.jpg',
  sampleUrl: null,
  fileUrl: 'https://cdn.donmai.us/original/ab/cd/abcd.png',
  mediaType: 'image',
  safety: 'safe',
  tags: ['cat'],
  unavailable: null,
}

function mountCard(props = {}) {
  return mount(RemotePostCard, {
    props: { post: POST, ...props },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('RemotePostCard', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the booru preview without a referrer', () => {
    const sankaku = { ...POST, key: 'sankaku:AbC', site: 'sankaku', id: 'AbC' }
    const img = mountCard({ post: sankaku }).get('img')
    expect(img.attributes('src')).toBe(POST.thumbUrl)
    expect(img.attributes('referrerpolicy')).toBe('no-referrer')
    expect(img.attributes('loading')).toBe('lazy')
    // Danbooru's CDN refuses image requests that carry no Referer at all.
    expect(mountCard().get('img').attributes('referrerpolicy')).toBe('strict-origin-when-cross-origin')
  })

  it('shows a placeholder with the site and id when the preview fails or is missing', async () => {
    const wrapper = mountCard()
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('.thumb-placeholder').text()).toContain('Danbooru')
    expect(wrapper.get('.thumb-placeholder').text()).toContain('#123')

    const missing = mountCard({ post: { ...POST, thumbUrl: null } })
    expect(missing.find('img').exists()).toBe(false)
    expect(missing.get('.thumb-placeholder').text()).toContain('#123')
  })

  it('opens the post on click outside select mode, toggles by key inside it', async () => {
    const wrapper = mountCard()
    await wrapper.trigger('click')
    expect(wrapper.emitted('open')).toEqual([['danbooru:123']])
    expect(wrapper.emitted('toggle')).toBeUndefined()

    await wrapper.setProps({ selectMode: true })
    await wrapper.trigger('click', { shiftKey: true })
    expect(wrapper.emitted('toggle')).toEqual([[{ key: 'danbooru:123', shiftKey: true }]])
    expect(wrapper.emitted('open')).toHaveLength(1)
    expect(wrapper.get('.select-check').exists()).toBe(true)
  })

  it('emits hold-select with the key after a 550 ms hold, and swallows that click', async () => {
    vi.useFakeTimers()
    const wrapper = mountCard()
    await wrapper.trigger('pointerdown', { button: 0 })
    vi.advanceTimersByTime(549)
    expect(wrapper.emitted('hold-select')).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(wrapper.emitted('hold-select')).toEqual([['danbooru:123']])
    await wrapper.trigger('pointerup')
    await wrapper.trigger('click')
    expect(wrapper.emitted('open')).toBeUndefined()

    // A short press is a plain click.
    await wrapper.trigger('pointerdown', { button: 0 })
    vi.advanceTimersByTime(200)
    await wrapper.trigger('pointerup')
    await wrapper.trigger('click')
    expect(wrapper.emitted('hold-select')).toHaveLength(1)
    expect(wrapper.emitted('open')).toEqual([['danbooru:123']])
  })

  it('hovers by key only in select mode', async () => {
    const wrapper = mountCard()
    await wrapper.trigger('pointerenter')
    expect(wrapper.emitted('hover-post')).toBeUndefined()
    await wrapper.setProps({ selectMode: true })
    await wrapper.trigger('pointerenter')
    expect(wrapper.emitted('hover-post')).toEqual([['danbooru:123']])
  })

  it('links the in-library badge to the local post', () => {
    expect(mountCard().find('.library-badge').exists()).toBe(false)
    const link = mountCard({ inLibraryPostId: 42 }).getComponent(RouterLinkStub)
    expect(link.props('to')).toBe('/post/42')
    expect(link.text()).toBe('in library')
  })

  it('marks videos and unavailable posts', () => {
    const video = mountCard({ post: { ...POST, mediaType: 'video' } })
    expect(video.find('.video-badge').exists()).toBe(true)
    const gone = mountCard({ post: { ...POST, fileUrl: null, unavailable: 'deleted' } })
    expect(gone.get('.unavailable-overlay').text()).toBe('Deleted')
  })

  it('fetches a fresh Sankaku preview once when the signed one has expired', async () => {
    const sankaku = reactive({ ...POST, key: 'sankaku:AbC', site: 'sankaku', id: 'AbC', thumbUrl: 'https://s.sankakucomplex.com/old.jpg?expires=1' })
    thumbHooks.thumbExpired.mockReturnValue(true)
    thumbHooks.refreshThumb.mockResolvedValue('https://s.sankakucomplex.com/fresh.jpg?expires=9999999999')
    const wrapper = mountCard({ post: sankaku })
    await wrapper.get('img').trigger('error')
    await flushPromises()
    expect(thumbHooks.refreshThumb).toHaveBeenCalledTimes(1)
    expect(thumbHooks.refreshThumb.mock.calls[0][0]).toBe(sankaku)
    expect(sankaku.thumbUrl).toBe('https://s.sankakucomplex.com/fresh.jpg?expires=9999999999')
    expect(wrapper.get('img').attributes('src')).toBe(sankaku.thumbUrl)

    // The fresh one failing too is final: no second refresh, the placeholder shows.
    await wrapper.get('img').trigger('error')
    await flushPromises()
    expect(thumbHooks.refreshThumb).toHaveBeenCalledTimes(1)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('.thumb-placeholder').text()).toContain('#AbC')
  })

  it('shows the placeholder when the preview has not expired or no fresh one comes', async () => {
    const sankaku = () => reactive({ ...POST, key: 'sankaku:AbC', site: 'sankaku', id: 'AbC' })
    thumbHooks.refreshThumb.mockClear()
    thumbHooks.thumbExpired.mockReturnValue(false)
    const live = mountCard({ post: sankaku() })
    await live.get('img').trigger('error')
    await flushPromises()
    expect(thumbHooks.refreshThumb).not.toHaveBeenCalled()
    expect(live.find('.thumb-placeholder').exists()).toBe(true)

    thumbHooks.thumbExpired.mockReturnValue(true)
    thumbHooks.refreshThumb.mockResolvedValue(null)
    const refused = mountCard({ post: sankaku() })
    await refused.get('img').trigger('error')
    await flushPromises()
    expect(thumbHooks.refreshThumb).toHaveBeenCalledTimes(1)
    expect(refused.find('.thumb-placeholder').exists()).toBe(true)
  })
})
