// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Pagination from './Pagination.vue'

const buttons = (wrapper) => wrapper.findAll('button')

describe('Pagination', () => {
  it('shows "Page 1 of 1" with both buttons disabled when everything fits on one page', () => {
    const wrapper = mount(Pagination, { props: { modelValue: 1, pages: 1 } })
    expect(wrapper.find('.pagination').exists()).toBe(true)
    expect(wrapper.text()).toContain('of 1')
    expect(buttons(wrapper).map((button) => button.element.disabled)).toEqual([true, true])
  })

  it('hides when a library search found nothing', () => {
    const wrapper = mount(Pagination, { props: { modelValue: 1, pages: 0 } })
    expect(wrapper.find('.pagination').exists()).toBe(false)
  })

  it('enables Next only while a later page exists', async () => {
    const wrapper = mount(Pagination, { props: { modelValue: 1, pages: 3 } })
    expect(buttons(wrapper).map((button) => button.element.disabled)).toEqual([true, false])
    await buttons(wrapper)[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[2]])
    await wrapper.setProps({ modelValue: 3 })
    expect(buttons(wrapper).map((button) => button.element.disabled)).toEqual([false, true])
  })
})
