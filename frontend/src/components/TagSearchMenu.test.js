// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

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
    expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(3)
    expect(document.body.querySelector('[data-path="/"]')?.getAttribute('data-query')).toBe('miyu_(blue_archive)')
  })

  it('opens Gelbooru and Safebooru searches in new tabs', async () => {
    const wrapper = mountMenu('blue hair')
    await wrapper.get('.tag-search-trigger').trigger('click')
    const external = [...document.body.querySelectorAll('a[target="_blank"]')]

    expect(external.map((link) => link.href)).toEqual([
      'https://gelbooru.com/index.php?page=post&s=list&tags=blue%20hair',
      'https://safebooru.org/index.php?page=post&s=list&tags=blue%20hair',
    ])
    expect(external.every((link) => link.rel === 'noopener noreferrer')).toBe(true)
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
