// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PostInspectorCard from './PostInspectorCard.vue'

const REMOTE = {
  key: 'danbooru:7',
  site: 'danbooru',
  id: '7',
  postUrl: 'https://danbooru.donmai.us/posts/7',
  thumbUrl: 'https://cdn.donmai.us/preview/7.jpg',
  fileExt: 'png',
  width: 1200,
  height: 800,
  fileSize: 2048,
  safety: 'sketchy',
  tags: ['cat_ears', 'solo'],
  source: 'https://example.com/art',
}

describe('PostInspectorCard', () => {
  it('shows a hovered booru post: thumb, site, booru link and tags', () => {
    const wrapper = mount(PostInspectorCard, { props: { remotePost: REMOTE } })
    expect(wrapper.find('.inspector-empty').exists()).toBe(false)
    const img = wrapper.get('img.inspector-thumb')
    expect(img.attributes('src')).toBe(REMOTE.thumbUrl)
    expect(img.attributes('referrerpolicy')).toBe('strict-origin-when-cross-origin')
    const link = wrapper.get('a.inspector-id')
    expect(link.attributes('href')).toBe(REMOTE.postUrl)
    expect(link.text()).toBe('#7')
    expect(wrapper.get('.inspector-site').text()).toBe('Danbooru')
    expect(wrapper.text()).toContain('1200 × 800')
    expect(wrapper.findAll('.inspector-tag-list span').map((tag) => tag.text())).toEqual(['cat_ears', 'solo'])
  })

  it('keeps the library post view and its local link', () => {
    const post = { id: 42, thumbUrl: '/t/42.webp', extension: '.png', safety: 'safe', tags: ['cat'] }
    const wrapper = mount(PostInspectorCard, { props: { post } })
    expect(wrapper.get('a.inspector-id').attributes('href')).toBe('/post/42')
    expect(wrapper.find('.inspector-site').exists()).toBe(false)
    expect(wrapper.get('img.inspector-thumb').attributes('referrerpolicy')).toBeUndefined()
  })
})
