// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import RemoteSection from './RemoteSection.vue'
import Pagination from '../Pagination.vue'

function section(overrides = {}) {
  return {
    site: 'danbooru',
    label: 'Danbooru',
    posts: [],
    cursor: null,
    loading: false,
    error: null,
    total: 20000,
    totalIsEstimate: false,
    page: 1,
    totalPages: 1000,
    hasPrev: false,
    hasNext: true,
    canJump: true,
    limit: 20,
    ignoredTerms: [],
    note: null,
    exhausted: false,
    waitingMs: 0,
    fetched: 0,
    ratingFiltered: 0,
    ...overrides,
  }
}

function mountSection(overrides) {
  return mount(RemoteSection, {
    props: { site: overrides?.site || 'danbooru', section: section(overrides) },
    global: { stubs: { RemotePostCard: true } },
  })
}

const buttons = (wrapper) => wrapper.get('.remote-section-footer').findAll('button')
const disabled = (button) => button.attributes('disabled') !== undefined

describe('RemoteSection page navigation', () => {
  it('disables Prev on page 1 and shows the capped page count with a jump box', () => {
    const wrapper = mountSection()
    expect(buttons(wrapper).map(disabled)).toEqual([true, false])
    expect(wrapper.get('.page-info').text()).toContain('of 1,000')
    expect(wrapper.find('input.page-jump').exists()).toBe(true)
  })

  it('disables Next on the last page and marks an estimated count', () => {
    const wrapper = mountSection({ page: 40, totalPages: 40, hasPrev: true, hasNext: false, totalIsEstimate: true })
    expect(buttons(wrapper).map(disabled)).toEqual([false, true])
    expect(wrapper.get('.page-info').text()).toContain('of ~40')
  })

  it('gives cursor-only Sankaku Prev/Next but no jump', () => {
    const wrapper = mountSection({ site: 'sankaku', label: 'Sankaku', canJump: false, page: 2, hasPrev: true, totalPages: null, total: null })
    expect(wrapper.find('input.page-jump').exists()).toBe(false)
    expect(buttons(wrapper).map(disabled)).toEqual([false, false])
    expect(wrapper.get('.page-info').text()).toMatch(/Page 2\s*🐾/u)
  })

  it('asks for the page and scrolls its header back into view', async () => {
    const scrollIntoView = vi.fn()
    const wrapper = mountSection({ page: 3, hasPrev: true })
    wrapper.element.scrollIntoView = scrollIntoView
    await buttons(wrapper)[1].trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('go-to-page')).toEqual([['danbooru', 4]])
    expect(scrollIntoView).toHaveBeenCalled()

    const jump = wrapper.get('input.page-jump')
    jump.element.value = '5000'
    await jump.trigger('change')
    expect(wrapper.emitted('go-to-page').at(-1)).toEqual(['danbooru', 1000])
  })

  it('locks the buttons while a page loads', () => {
    const wrapper = mountSection({ page: 2, hasPrev: true, loading: true })
    expect(buttons(wrapper).map(disabled)).toEqual([true, true])
  })
})

describe('Pagination for the library', () => {
  it('still renders from modelValue and pages alone', () => {
    const wrapper = mount(Pagination, { props: { modelValue: 1, pages: 3 } })
    expect(wrapper.get('.page-info').text()).toBe('🐾 Page 1 of 3 🐾')
    expect(wrapper.findAll('button').map(disabled)).toEqual([true, false])
    expect(mount(Pagination, { props: { modelValue: 1, pages: 1 } }).find('.pagination').exists()).toBe(false)
  })
})
