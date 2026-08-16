// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import RemoteClipEditor from './RemoteClipEditor.vue'
import UploadJobProgress from './UploadJobProgress.vue'

vi.mock('../api/client', () => ({
  default: {
    getUploadJob: vi.fn(),
  },
}))

describe('RemoteClipEditor', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('preserves a late start time while the end field is still being edited', async () => {
    const wrapper = mount(RemoteClipEditor, {
      global: {
        stubs: {
          TagInput: true,
          UploadJobProgress: true,
          RouterLink: true,
        },
      },
    })
    await flushPromises()
    const fields = wrapper.findAll('.source-grid input')
    expect(fields).toHaveLength(3)

    await fields[0].setValue('https://www.youtube.com/watch?v=v3V-X_BRp_o')
    await fields[1].setValue('32:35')
    await fields[1].trigger('blur')
    await fields[2].setValue('33:10')
    await fields[2].trigger('blur')

    expect(fields[1].element.value).toBe('32:35.000')
    expect(fields[2].element.value).toBe('33:10.000')
    expect(wrapper.get('.load-btn').attributes('disabled')).toBeUndefined()
  })
})

describe('UploadJobProgress', () => {
  it('exposes overall and stage progress accessibly', () => {
    const wrapper = mount(UploadJobProgress, {
      props: {
        job: {
          status: 'sampling',
          message: 'Downloading bounded preview range',
          overallProgress: 33,
          metrics: { downloadedBytes: 1024, totalBytes: 4096 },
          stages: [
            { id: 'download', label: 'Download selected range', state: 'running', progress: 51, detail: 'Downloading' },
          ],
        },
      },
      global: { stubs: { RouterLink: true } },
    })

    const bars = wrapper.findAll('[role="progressbar"]')
    expect(bars).toHaveLength(2)
    expect(bars[0].attributes('aria-valuenow')).toBe('33')
    expect(bars[1].attributes('aria-valuenow')).toBe('51')
    expect(wrapper.text()).toContain('1.00 KB / 4.00 KB')
  })
})
