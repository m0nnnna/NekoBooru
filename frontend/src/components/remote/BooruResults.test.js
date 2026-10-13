// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import BooruResults from './BooruResults.vue'

const post = (site, id) => ({ key: `${site}:${id}`, site, id: String(id) })

function section(site, page, extra = {}) {
  return { site, label: site, page, totalPages: null, totalIsEstimate: false, hasNext: false, error: null, posts: [], ...extra }
}

// Interleaved: one library page of 12 posts, Danbooru with 4 pages, e621 with
// an estimated 6.
function setup({ libraryPage = 1, libraryPages = 1, danbooru = {}, e621 = {} } = {}) {
  const booru = reactive({
    layout: 'interleaved',
    libraryShown: true,
    anyLoading: false,
    order: ['danbooru', 'e621'],
    sections: {
      danbooru: section('danbooru', 1, { totalPages: 4, hasNext: true, ...danbooru }),
      e621: section('e621', 1, { totalPages: 6, totalIsEstimate: true, hasNext: true, ...e621 }),
    },
    feed: [post('danbooru', 1), post('e621', 1)],
    inLibraryPostId: () => null,
    goToPage: vi.fn(() => true),
    stepAll: vi.fn(),
    retry: vi.fn(),
    openPost: vi.fn(),
  })
  const library = reactive({ posts: [{ id: 1 }, { id: 2 }], loading: false, page: libraryPage, pages: libraryPages, total: 12 })
  const wrapper = mount(BooruResults, {
    props: { booru, library },
    global: { stubs: { PostCard: { template: '<div class="library-card" />' }, RemotePostCard: { props: ['post'], template: '<div class="remote-card" :data-key="post.key" />' } } },
  })
  return { wrapper, booru, library }
}

const pagers = (wrapper) => wrapper.findAll('.pagination')
const pageInfo = (wrapper) => wrapper.findAll('.page-info').map((info) => info.text())

describe('BooruResults interleaved paging', () => {
  it('counts the whole feed: the most pages any source has, "~" when that is an estimate', () => {
    const { wrapper } = setup()
    expect(pagers(wrapper)).toHaveLength(2)
    expect(pageInfo(wrapper)).toEqual(['🐾 Page 1 of ~6 🐾', '🐾 Page 1 of ~6 🐾'])
  })

  it('leaves the count off while a source has no total yet', () => {
    const { wrapper } = setup({ e621: { totalPages: null, totalIsEstimate: false } })
    expect(pageInfo(wrapper)[0]).toBe('🐾 Page 1 🐾')
    expect(pagers(wrapper)[0].findAll('button').map((b) => b.element.disabled)).toEqual([true, false])
  })

  it('Next moves every source to the same page and the library only while it has one', async () => {
    const { wrapper, booru } = setup()
    await pagers(wrapper)[0].findAll('button')[1].trigger('click')
    expect(booru.goToPage.mock.calls).toEqual([['danbooru', 2], ['e621', 2]])
    expect(wrapper.emitted('page-change')).toBeUndefined()
  })

  it('pages the library along with the boorus when it has more pages', async () => {
    const { wrapper, booru } = setup({ libraryPages: 3 })
    await pagers(wrapper)[0].findAll('button')[1].trigger('click')
    expect(booru.goToPage).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('page-change')).toEqual([[2]])
  })

  it('drops a source that ran out from the later pages instead of repeating it', () => {
    // Feed on page 3: Danbooru reached it, the library (1 page) and e621
    // (stuck on 2) did not.
    const { wrapper } = setup({ danbooru: { page: 3 }, e621: { page: 2, hasNext: false, totalPages: 2, totalIsEstimate: false } })
    expect(pageInfo(wrapper)[0]).toBe('🐾 Page 3 of 4 🐾')
    expect(wrapper.findAll('.library-card')).toHaveLength(0)
    expect(wrapper.findAll('.remote-card').map((card) => card.attributes('data-key'))).toEqual(['danbooru:1'])
  })

  it('shows "Page 1 of 1" with both buttons off when every source fits on one page', () => {
    const { wrapper } = setup({ danbooru: { totalPages: 1, hasNext: false }, e621: { totalPages: 1, totalIsEstimate: false, hasNext: false } })
    expect(pageInfo(wrapper)[0]).toBe('🐾 Page 1 of 1 🐾')
    expect(pagers(wrapper)[0].findAll('button').map((b) => b.element.disabled)).toEqual([true, true])
  })
})
