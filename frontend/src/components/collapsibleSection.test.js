// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import CollapsibleSection from './CollapsibleSection.vue'

describe('CollapsibleSection', () => {
  it('hides its body when collapsed but keeps it mounted', () => {
    const wrapper = mount(CollapsibleSection, {
      props: { title: 'Auto Tagging', open: false },
      slots: { default: '<p class="probe">body</p>' },
    })

    const toggle = wrapper.get('.section-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('h2').text()).toBe('Auto Tagging')
    // v-show, not v-if: polling timers and form state inside a section must survive collapsing.
    const body = wrapper.get('.section-body')
    expect(wrapper.find('.probe').exists()).toBe(true)
    expect(body.element.style.display).toBe('none')
  })

  it('shows its body and reports expanded when open', () => {
    const wrapper = mount(CollapsibleSection, {
      props: { title: 'Server', open: true },
      slots: { default: '<p class="probe">body</p>' },
    })

    expect(wrapper.get('.section-toggle').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.section-body').element.style.display).toBe('')
  })

  it('emits toggle instead of managing its own state', async () => {
    const wrapper = mount(CollapsibleSection, {
      props: { title: 'Search', open: false },
    })

    await wrapper.get('.section-toggle').trigger('click')

    expect(wrapper.emitted('toggle')).toHaveLength(1)
    // Still closed: the parent owns the state so "expand/collapse all" stays authoritative.
    expect(wrapper.get('.section-toggle').attributes('aria-expanded')).toBe('false')
  })
})
