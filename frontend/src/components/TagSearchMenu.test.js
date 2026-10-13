// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const resolveE621Name = vi.fn()
vi.mock('../api/client', () => ({ default: { resolveE621Name: (...args) => resolveE621Name(...args) } }))

import TagSearchMenu from './TagSearchMenu.vue'

let activeWrapper

const RouterLinkStub = {
  props: ['to'],
  template: '<a :data-path="to.path" :data-query="to.query.q"><slot /></a>',
}

function mountMenu(tag = 'miyu_(blue_archive)') {
  activeWrapper = mount(TagSearchMenu, {
    attachTo: document.body,
    props: { tag, label: 'Miyu (Blue Archive)' },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
  return activeWrapper
}

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  document.body.classList.remove('dark-mode')
  document.body.innerHTML = ''
})

describe('TagSearchMenu', () => {
  it('opens search choices when the tag is clicked', async () => {
    const wrapper = mountMenu()
    const trigger = wrapper.get('.tag-search-trigger')

    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')

    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(6)
    expect(document.body.querySelector('[data-path="/"]')?.getAttribute('data-query')).toBe('miyu_(blue_archive)')
  })

  it('opens Gelbooru, Safebooru, e621, and both Sankaku searches in new tabs', async () => {
    const wrapper = mountMenu('blue hair')
    await wrapper.get('.tag-search-trigger').trigger('click')
    const external = [...document.body.querySelectorAll('a[target="_blank"]')]

    expect(external.map((link) => link.href)).toEqual([
      'https://gelbooru.com/index.php?page=post&s=list&tags=blue%20hair',
      'https://safebooru.org/index.php?page=post&s=list&tags=blue%20hair',
      'https://e621.net/posts?tags=blue%20hair',
      'https://chan.sankakucomplex.com/?tags=blue%20hair',
      'https://sankaku.app/?tags=blue%20hair',
    ])
    expect(external.every((link) => link.rel === 'noopener noreferrer')).toBe(true)
  })

  it('searches the boorus with the display name spelling the stored name lost', async () => {
    activeWrapper = mount(TagSearchMenu, {
      attachTo: document.body,
      props: { tag: 'seitokai_ni_mo_ana_wa_aru', displayName: 'seitokai ni mo ana wa aru!' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    await activeWrapper.get('.tag-search-trigger').trigger('click')
    const external = [...document.body.querySelectorAll('a[target="_blank"]')]

    expect(external[0].href).toBe('https://gelbooru.com/index.php?page=post&s=list&tags=seitokai_ni_mo_ana_wa_aru!')
    expect(document.body.querySelector('[data-path="/"]')?.getAttribute('data-query')).toBe('seitokai_ni_mo_ana_wa_aru')
  })

  it("searches Sankaku under its own name while the other boorus keep theirs", async () => {
    activeWrapper = mount(TagSearchMenu, {
      attachTo: document.body,
      props: { tag: 'honoka_doa', displayName: 'honoka (doa)', sankakuName: 'honoka_(dead_or_alive)' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    await activeWrapper.get('.tag-search-trigger').trigger('click')
    const external = [...document.body.querySelectorAll('a[target="_blank"]')].map((link) => link.href)

    expect(external).toEqual([
      'https://gelbooru.com/index.php?page=post&s=list&tags=honoka_(doa)',
      'https://safebooru.org/index.php?page=post&s=list&tags=honoka_(doa)',
      'https://e621.net/posts?tags=honoka_(doa)',
      'https://chan.sankakucomplex.com/?tags=honoka_(dead_or_alive)',
      'https://sankaku.app/?tags=honoka_(dead_or_alive)',
    ])
  })

  it('resolves the e621 name on the first click and links straight to it afterwards', async () => {
    resolveE621Name.mockResolvedValue({ e621Name: 'yui_hirasawa', found: true })
    const tab = { location: { href: '' } }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab)
    activeWrapper = mount(TagSearchMenu, {
      attachTo: document.body,
      props: { tag: 'hirasawa_yui' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    const trigger = activeWrapper.get('.tag-search-trigger')
    await trigger.trigger('click')
    const e621 = () => [...document.body.querySelectorAll('a[target="_blank"]')].find((link) => link.href.startsWith('https://e621.net'))
    e621().dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(tab.location.href).toBe('https://e621.net/posts?tags=yui_hirasawa'))

    await trigger.trigger('click')
    expect(e621().href).toBe('https://e621.net/posts?tags=yui_hirasawa')
    expect(resolveE621Name).toHaveBeenCalledTimes(1)
    open.mockRestore()
  })

  it('links a stored e621 name without asking', async () => {
    activeWrapper = mount(TagSearchMenu, {
      attachTo: document.body,
      props: { tag: 'hirasawa_yui', e621Name: 'yui_hirasawa' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    await activeWrapper.get('.tag-search-trigger').trigger('click')
    expect(document.body.querySelector('a[href^="https://e621.net"]')?.href).toBe('https://e621.net/posts?tags=yui_hirasawa')
  })

  it('keeps the active dark theme when the menu is teleported', async () => {
    document.body.classList.add('dark-mode')
    const wrapper = mountMenu()
    await wrapper.get('.tag-search-trigger').trigger('click')

    expect(document.body.querySelector('[role="menu"]')?.classList.contains('dark-mode')).toBe(true)
  })

  it('closes when Escape is pressed', async () => {
    const wrapper = mountMenu()
    await wrapper.get('.tag-search-trigger').trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.tag-search-trigger').attributes('aria-expanded')).toBe('false')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })
})
