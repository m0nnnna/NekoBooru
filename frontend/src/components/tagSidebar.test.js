// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import TagSidebar from './TagSidebar.vue'

const RouterLinkStub = {
  props: ['to'],
  template: '<a><slot /></a>',
}

function mountSidebar(tags) {
  return mount(TagSidebar, {
    props: { tags },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

const SAMPLE = [
  { name: '1girl', category: 'general', categoryColor: '#0075f8', usageCount: 9522936 },
  { name: 'code_geass', category: 'copyright', categoryColor: '#d500f9', usageCount: 20164 },
  { name: 'xinglanlans', category: 'artist', categoryColor: '#f8a100', usageCount: 6 },
  { name: 'kouzuki_kallen', category: 'character', categoryColor: '#00c853', usageCount: 4729 },
  { name: 'cosplay_photo', category: 'meta', categoryColor: '#ff5252', usageCount: 5856 },
  { name: 'bare_shoulders', category: 'general', categoryColor: '#0075f8', usageCount: 1422752 },
]

describe('TagSidebar', () => {
  it('groups tags in Danbooru sidebar order with display labels', () => {
    const headings = mountSidebar(SAMPLE).findAll('.tag-group-heading').map((h) => h.text())
    expect(headings).toEqual(['Artist', 'Character', 'Copyright', 'Metadata', 'Tag'])
  })

  it('shows underscores as spaces but searches the real tag name', () => {
    const wrapper = mountSidebar(SAMPLE)
    const link = wrapper.findAll('.tag-name').find((el) => el.text() === 'kouzuki kallen')
    expect(link).toBeTruthy()
    expect(link.attributes('title')).toBe('kouzuki_kallen')
  })

  it('prefers the spelling the tagger reported over the flattened name', () => {
    const wrapper = mountSidebar([
      { name: 'miyu_blue_archive', displayName: 'miyu (blue archive)', category: 'character', categoryColor: '#00c853' },
      { name: 'miyu_swimsuit_blue_archive', displayName: 'miyu (swimsuit) (blue archive)', category: 'character', categoryColor: '#00c853' },
    ])
    const names = wrapper.findAll('.tag-name')
    expect(names.map((el) => el.text())).toEqual([
      'miyu (blue archive)',
      'miyu (swimsuit) (blue archive)',
    ])
    // The link still targets the stored name, not the display spelling.
    expect(names[0].attributes('title')).toBe('miyu_blue_archive')
  })

  it('abbreviates large counts', () => {
    const counts = mountSidebar(SAMPLE).findAll('.tag-count').map((el) => el.text())
    expect(counts).toContain('6')
    expect(counts).toContain('4729')
    expect(counts).toContain('9.5M')
  })

  it('omits categories with no tags', () => {
    const wrapper = mountSidebar([SAMPLE[0]])
    expect(wrapper.findAll('.tag-group-heading').map((h) => h.text())).toEqual(['Tag'])
  })

  it('accepts bare tag-name strings so it degrades before tagDetails loads', () => {
    const wrapper = mountSidebar(['solo', 'indoors'])
    expect(wrapper.findAll('.tag-group-heading').map((h) => h.text())).toEqual(['Tag'])
    expect(wrapper.findAll('.tag-name').map((el) => el.text())).toEqual(['indoors', 'solo'])
  })

  it('keeps unknown custom categories instead of dropping their tags', () => {
    const wrapper = mountSidebar([...SAMPLE, { name: 'scanned', category: 'lore' }])
    const headings = wrapper.findAll('.tag-group-heading').map((h) => h.text())
    expect(headings).toContain('lore')
  })
})
