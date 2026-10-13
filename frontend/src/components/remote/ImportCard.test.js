// @vitest-environment jsdom
import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getPools: null }))

vi.mock('../../api/client', () => {
  const api = { getPools: (...args) => mocks.getPools(...args) }
  return { api, default: api }
})

import ImportCard from './ImportCard.vue'
import { NEW_POOL, useImportQueue } from '../../remote/useImportQueue.js'

const TagInputStub = {
  name: 'TagInput',
  props: { modelValue: { type: Array, required: true }, placeholder: String },
  emits: ['update:modelValue'],
  template: '<input class="tag-input-stub" :value="modelValue.join(\',\')" @change="$emit(\'update:modelValue\', $event.target.value.split(\',\').filter(Boolean))" />',
}

const POOLS = [{ id: 3, name: 'Favourites' }, { id: 7, name: 'Wallpapers' }]

function remotePost(site, id, extra = {}) {
  return {
    key: `${site}:${id}`,
    site,
    id: String(id),
    postUrl: `https://example.test/${site}/${id}`,
    thumbUrl: null,
    fileUrl: `https://example.test/${site}/${id}.png`,
    tags: [],
    ...extra,
  }
}

// Mirrors the shape useImportQueue() returns, with spies for the actions.
function fakeQueue() {
  const items = reactive([])
  const queue = {
    items,
    running: ref(false),
    poolResult: ref(null),
    options: reactive({ autoTag: false, extraTags: [], safetyOverride: '', poolId: null, newPoolName: '' }),
    progress: computed(() => ({
      done: items.filter((item) => item.status === 'done').length,
      total: items.length,
      failed: items.filter((item) => item.status === 'failed').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
    })),
    enqueue: vi.fn((posts) => posts.map((post) => ({ key: post.key, post, status: 'queued' }))),
    start: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
    clearFinished: vi.fn(),
  }
  return queue
}

function item(post, status, message, extra = {}) {
  return { key: post.key, post, status, message, postId: null, duplicate: false, attempt: 0, ...extra }
}

async function mountCard(props) {
  const wrapper = mount(ImportCard, {
    props,
    global: { stubs: { TagInput: TagInputStub, RouterLink: RouterLinkStub } },
  })
  await flushPromises()
  return wrapper
}

const button = (wrapper, name) => wrapper.get(`[data-test="${name}"]`)

describe('ImportCard', () => {
  beforeEach(() => {
    mocks.getPools = vi.fn(async () => ({ results: POOLS }))
  })

  it('shows the queue option defaults: auto-tag off, no override, no pool', async () => {
    const queue = fakeQueue()
    const wrapper = await mountCard({ queue, selectedRemote: [remotePost('danbooru', 1)] })

    expect(button(wrapper, 'auto-tag').element.checked).toBe(false)
    expect(button(wrapper, 'safety').element.value).toBe('')
    expect(wrapper.find('[data-test="new-pool-name"]').exists()).toBe(false)
    expect(queue.options.poolId).toBe(null)
    expect(button(wrapper, 'start').text()).toBe('Import 1 post')
  })

  it('renders the real useImportQueue defaults the same way', async () => {
    const queue = useImportQueue({ api: {} })
    queue.start = vi.fn()
    const wrapper = await mountCard({ queue, selectedRemote: [] })

    expect(queue.options.autoTag).toBe(false)
    expect(button(wrapper, 'auto-tag').element.checked).toBe(false)
    expect(button(wrapper, 'start').text()).toBe('Import 0 posts')
  })

  it('writes the options back into the queue', async () => {
    const queue = fakeQueue()
    const wrapper = await mountCard({ queue, selectedRemote: [remotePost('danbooru', 1)] })

    await button(wrapper, 'auto-tag').setValue(true)
    await button(wrapper, 'safety').setValue('unsafe')
    await wrapper.get('.tag-input-stub').setValue('wallpaper,from_booru')

    expect(queue.options.autoTag).toBe(true)
    expect(queue.options.safetyOverride).toBe('unsafe')
    expect(queue.options.extraTags).toEqual(['wallpaper', 'from_booru'])
  })

  it('Start enqueues only the remote selections, then starts the queue', async () => {
    const queue = fakeQueue()
    const danbooru = remotePost('danbooru', 1)
    const e621 = remotePost('e621', 2)
    const library = { key: 'nekobooru:42', site: 'nekobooru', id: '42' }
    const wrapper = await mountCard({
      queue,
      selectedRemote: [danbooru, library, null, { key: 'mystery:1', site: 'mystery' }, e621],
    })

    expect(button(wrapper, 'start').text()).toBe('Import 2 posts')
    await button(wrapper, 'start').trigger('click')

    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(queue.enqueue.mock.calls[0][0]).toEqual([danbooru, e621])
    expect(queue.start).toHaveBeenCalledTimes(1)
    expect(queue.enqueue.mock.invocationCallOrder[0]).toBeLessThan(queue.start.mock.invocationCallOrder[0])
    const [payload] = wrapper.emitted('start')[0]
    expect(payload.posts).toEqual([danbooru, e621])
    expect(payload.added).toHaveLength(2)
  })

  it('disables Start without remote posts, Cancel when idle, Clear without finished items', async () => {
    const queue = fakeQueue()
    const wrapper = await mountCard({ queue, selectedRemote: [{ key: 'nekobooru:1', site: 'nekobooru', id: '1' }] })

    expect(button(wrapper, 'start').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'cancel').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'clear').attributes('disabled')).toBeDefined()
    await button(wrapper, 'start').trigger('click')
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('while running: options locked, Start adds to the queue, Cancel and Clear act on the queue', async () => {
    const queue = fakeQueue()
    const post = remotePost('danbooru', 1)
    const finished = remotePost('danbooru', 2)
    queue.items.push(item(post, 'downloading', 'Downloading original…'), item(finished, 'done', 'Imported · #9', { postId: 9 }))
    queue.running.value = true
    const wrapper = await mountCard({ queue, selectedRemote: [remotePost('sankaku', 'ab1')] })

    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'start').text()).toBe('Add 1 post to queue')
    expect(button(wrapper, 'start').attributes('disabled')).toBeUndefined()
    await button(wrapper, 'cancel').trigger('click')
    await button(wrapper, 'clear').trigger('click')
    expect(queue.cancel).toHaveBeenCalledTimes(1)
    expect(queue.clearFinished).toHaveBeenCalledTimes(1)

    queue.running.value = false
    await flushPromises()
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined()
    expect(button(wrapper, 'cancel').attributes('disabled')).toBeDefined()
  })

  it('renders a status line per item and the overall progress', async () => {
    const queue = fakeQueue()
    const posts = [1, 2, 3, 4, 5, 6].map((id) => remotePost('danbooru', id))
    queue.items.push(
      item(posts[0], 'checking', 'Checking the library…'),
      item(posts[1], 'downloading', 'Downloading original… 12.3 / 36.0 MB (34%) · 180 KB/s · 70s'),
      item(posts[2], 'saving', 'Saving post…'),
      item(posts[3], 'done', 'Imported · #41', { postId: 41 }),
      item(posts[4], 'skipped', 'Already in NekoBooru · tags merged · #42', { postId: 42 }),
      item(posts[5], 'failed', 'No original file · deleted on the site'),
    )
    queue.running.value = true
    const wrapper = await mountCard({ queue, selectedRemote: [] })

    const rows = wrapper.findAll('[data-test="items"] li')
    expect(rows.map((row) => row.attributes('data-status')))
      .toEqual(['checking', 'downloading', 'saving', 'done', 'skipped', 'failed'])
    expect(rows[0].text()).toContain('Danbooru #1')
    expect(rows[0].text()).toContain('Checking')
    expect(rows[1].text()).toContain('12.3 / 36.0 MB (34%)')
    expect(rows[2].text()).toContain('Saving post…')
    expect(rows[3].text()).toContain('Imported · #41')
    expect(rows[4].text()).toContain('In library')
    expect(rows[4].text()).toContain('tags merged')
    expect(rows[5].text()).toContain('Failed')
    expect(rows[5].text()).toContain('deleted on the site')
    expect(rows[3].findComponent(RouterLinkStub).props('to')).toBe('/post/41')
    expect(rows[1].findComponent(RouterLinkStub).exists()).toBe(false)

    const progress = button(wrapper, 'progress')
    expect(progress.text()).toContain('Importing…')
    expect(progress.text()).toContain('3 / 6')
    expect(progress.text()).toContain('imported 1')
    expect(progress.text()).toContain('merged 1')
    expect(progress.text()).toContain('failed 1')
    expect(progress.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50')
    expect(button(wrapper, 'clear').attributes('disabled')).toBeUndefined()
  })

  it('labels a duplicate that was merged on save', async () => {
    const queue = fakeQueue()
    const post = remotePost('e621', 5)
    queue.items.push(item(post, 'done', 'Already existed · tags merged · #8', { postId: 8, duplicate: true }))
    const wrapper = await mountCard({ queue, selectedRemote: [] })

    expect(wrapper.get('[data-test="items"] li').text()).toContain('Merged')
    expect(button(wrapper, 'progress').text()).toContain('Import finished')
  })

  it('shows a rate-limit back-off while an item is retrying', async () => {
    const queue = fakeQueue()
    const post = remotePost('danbooru', 1)
    queue.items.push(item(post, 'retrying', 'Danbooru asked to slow down · retrying in 30 s…', { attempt: 2 }))
    queue.running.value = true
    const wrapper = await mountCard({ queue, selectedRemote: [] })

    const backoff = button(wrapper, 'backoff')
    expect(backoff.text()).toContain('Rate limited · attempt 2 of 3')
    expect(backoff.text()).toContain('retrying in 30 s')

    queue.items[0].status = 'downloading'
    await flushPromises()
    expect(wrapper.find('[data-test="backoff"]').exists()).toBe(false)
  })

  it('lists existing pools and offers a new pool by name', async () => {
    const queue = fakeQueue()
    const wrapper = await mountCard({ queue, selectedRemote: [remotePost('danbooru', 1)] })

    expect(mocks.getPools).toHaveBeenCalledWith({ limit: 100 })
    const labels = button(wrapper, 'pool').findAll('option').map((option) => option.text())
    expect(labels).toEqual(['No pool', 'Favourites', 'Wallpapers', 'Create new pool…'])

    await button(wrapper, 'pool').findAll('option')[2].setSelected()
    expect(queue.options.poolId).toBe(7)
    expect(wrapper.find('[data-test="new-pool-name"]').exists()).toBe(false)

    await button(wrapper, 'pool').findAll('option')[3].setSelected()
    expect(queue.options.poolId).toBe(NEW_POOL)
    await button(wrapper, 'new-pool-name').setValue('Danbooru haul')
    expect(queue.options.newPoolName).toBe('Danbooru haul')

    await button(wrapper, 'pool').findAll('option')[0].setSelected()
    expect(queue.options.poolId).toBe(null)
  })

  it('reports the pool result and selects a newly created pool for the next run', async () => {
    const queue = fakeQueue()
    queue.options.poolId = NEW_POOL
    queue.options.newPoolName = 'Danbooru haul'
    const wrapper = await mountCard({ queue, selectedRemote: [] })

    mocks.getPools = vi.fn(async () => ({ results: [...POOLS, { id: 11, name: 'Danbooru haul' }] }))
    queue.poolResult.value = { poolId: 11, added: 2, error: null }
    await flushPromises()

    expect(button(wrapper, 'pool-result').text()).toBe('Added 2 posts to "Danbooru haul".')
    expect(queue.options.poolId).toBe(11)
    expect(queue.options.newPoolName).toBe('')

    queue.poolResult.value = { poolId: null, added: 0, error: 'Pool name taken' }
    await flushPromises()
    expect(button(wrapper, 'pool-result').text()).toContain('Pool name taken')
  })

  it('still works when the pools cannot be loaded', async () => {
    mocks.getPools = vi.fn(async () => { throw new Error('offline') })
    const queue = fakeQueue()
    const wrapper = await mountCard({ queue, selectedRemote: [remotePost('danbooru', 1)] })

    expect(wrapper.text()).toContain('Pools could not be loaded: offline')
    expect(button(wrapper, 'pool').findAll('option').map((option) => option.text()))
      .toEqual(['No pool', 'Create new pool…'])
  })

  it('warns about selected posts with no original file', async () => {
    const queue = fakeQueue()
    const wrapper = await mountCard({
      queue,
      selectedRemote: [remotePost('danbooru', 1, { fileUrl: null, unavailable: 'hidden' }), remotePost('danbooru', 2)],
    })

    expect(wrapper.text()).toContain('1 selected post has no original file')
  })
})
