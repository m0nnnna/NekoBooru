// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MODELS = [
  { id: 'wd', name: 'WD Tagger', repoId: 'SmilingWolf/wd', purpose: 'Booru tags', downloaded: true, loaded: false, runtimeAvailable: true, status: 'tagging_ready' },
  { id: 'qwen', name: 'Qwen2.5-VL', repoId: 'Qwen/Qwen2.5-VL', purpose: 'Semantic', role: 'semantic', downloaded: false, loaded: false, runtimeAvailable: false, status: 'tagging_ready' },
]

vi.mock('../api/client', () => {
  const api = {
    getSettings: vi.fn(async () => ({ data_dir: '/srv/neko', host: '127.0.0.1', port: 8000, database_path: '/srv/neko/db.sqlite' })),
    getExtensionSettings: vi.fn(async () => ({ saveTweetTag: true })),
    updateExtensionSettings: vi.fn(async (value) => value),
    getAutoTagSettings: vi.fn(async () => ({ enabled: true, semanticModelId: 'qwen' })),
    getAutoTagStatus: vi.fn(async () => ({ enabled: true, dependencies: { onnxruntime: true }, torch: {} })),
    getCurrentAutoTagJob: vi.fn(async () => null),
    getAutoTagModels: vi.fn(async () => ({ models: MODELS, downloadJob: null })),
    getYtdlpStatus: vi.fn(async () => ({ installed: true, version: '2026.01.01', updatePolicy: 'manual' })),
    getRuntimeStatus: vi.fn(async () => ({ app: { packaged: false, version: '4.1.0' } })),
    getAiRuntimeProfiles: vi.fn(async () => ({ profiles: [] })),
    getUpdateStatus: vi.fn(async () => ({ currentVersion: '4.1.0', settings: {} })),
    getAiModelDefaults: vi.fn(async () => ({ modelDefaults: {} })),
    getDirectory: vi.fn(async () => ['alice']),
    getShares: vi.fn(async () => ({ sharedByMe: [] })),
    getMe: vi.fn(async () => ({ sharedWithMe: [] })),
    getApiTokens: vi.fn(async () => [{ id: 1, label: 'Browser Extension', createdAt: '2026-01-02T00:00:00Z' }]),
    getAutoTagJobSuggestions: vi.fn(async () => [{ id: 1, postId: 5, status: 'suggested', suggestedTags: ['cat'], suggestedSafety: 'safe' }]),
    updateDataDir: vi.fn(async () => ({ needs_migration: true, old_path: '/srv/neko', new_path: '/mnt/neko' })),
  }
  return { api, default: api }
})

import SettingsView from './SettingsView.vue'

async function mountSettings() {
  const wrapper = mount(SettingsView, { global: { plugins: [createPinia()] } })
  await flushPromises()
  return wrapper
}

const SECTION_TITLES = [
  'Data Storage',
  'Search',
  'AI Model Defaults',
  'Browser Extension',
  'Server',
  'Video Downloads (yt-dlp)',
  'Directory Information',
  'Runtime & Packaging',
  'App Updates',
  'Auto Tagging',
  'Restart',
  'Account & Sharing',
]

describe('SettingsView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders every section with its loaded content', async () => {
    const wrapper = await mountSettings()
    expect(wrapper.findAll('.settings-section h2').map((h) => h.text())).toEqual(SECTION_TITLES)
    expect(wrapper.get('.settings-header-count').text()).toBe('0 of 12 open')

    await wrapper.findAll('.settings-header-actions button').find((b) => b.text() === 'Expand all').trigger('click')
    expect(wrapper.get('.settings-header-count').text()).toBe('12 of 12 open')
    expect(JSON.parse(localStorage.getItem('nekobooru.settingsSectionsOpen'))['account-sharing']).toBe(true)

    expect(wrapper.get('.path-input').element.value).toBe('/srv/neko')
    expect(wrapper.text()).toContain('Packaged URL: http://127.0.0.1:8000')
    expect(wrapper.findAll('.profile-default-card')).toHaveLength(3)
    expect(wrapper.get('.ytdlp-status-grid').text()).toContain('Ready')
    expect(wrapper.get('.info-grid').text()).toContain('/srv/neko/db.sqlite')
    expect(wrapper.get('.pipeline-grid').text()).toContain('1 / 2')
    expect(wrapper.findAll('.compact-model-row').map((row) => row.get('.model-title strong').text())).toEqual(['WD Tagger'])
    expect(wrapper.get('.semantic-model-card').text()).toContain('Qwen2.5-VL')
    expect(wrapper.get('.bulk-defaults-note').text()).toContain('WD Tagger')
    expect(wrapper.get('.users-table').text()).toContain('Browser Extension')
    expect(wrapper.find('.preview-modal').exists()).toBe(false)
  })

  it('saves the browser extension defaults', async () => {
    const { api } = await import('../api/client')
    const wrapper = await mountSettings()
    const save = wrapper.findAll('button').find((b) => b.text() === 'Save Extension Defaults')
    await save.trigger('click')
    await flushPromises()
    expect(api.updateExtensionSettings).toHaveBeenCalledWith({
      saveTweetTag: true,
      saveTweetUsername: false,
      saveSourcePageUrl: true,
      saveMediaUrl: false,
      saveSemanticAnalysis: false,
    })
    expect(wrapper.text()).toContain('Extension defaults saved.')
  })

  it('opens the preview suggestions dialog once', async () => {
    const { api } = await import('../api/client')
    api.getCurrentAutoTagJob.mockResolvedValueOnce({ id: 4, status: 'completed', dryRun: true, processed: 1, total: 1 })
    const wrapper = await mountSettings()
    await wrapper.findAll('button').find((b) => b.text() === 'View Preview').trigger('click')
    await flushPromises()
    expect(api.getAutoTagJobSuggestions).toHaveBeenCalledWith(4, { page: 1, limit: 100 })
    expect(wrapper.findAll('.preview-modal')).toHaveLength(1)
    expect(wrapper.get('.preview-modal').text()).toContain('Post #5')
  })

  it('hides the migration prompt on Cancel', async () => {
    const wrapper = await mountSettings()
    await wrapper.get('.path-input').setValue('/mnt/neko')
    await wrapper.findAll('button').find((b) => b.text() === 'Save Settings').trigger('click')
    await flushPromises()
    expect(wrapper.find('.migration-prompt').text()).toContain('/mnt/neko')

    await wrapper.findAll('.migration-actions button').find((b) => b.text() === 'Cancel').trigger('click')
    expect(wrapper.find('.migration-prompt').exists()).toBe(false)
    expect(wrapper.get('.path-input').element.value).toBe('/srv/neko')
  })
})

const SETTINGS_SECTION_SOURCES = import.meta.glob('../components/settings/*.vue', { query: '?raw', import: 'default', eager: true })
const SETTINGS_VIEW_SOURCE = import.meta.glob('./SettingsView.vue', { query: '?raw', import: 'default', eager: true })['./SettingsView.vue']

describe('settings form styles', () => {
  it('keeps the shared form rules in one sheet SettingsView loads', () => {
    expect(SETTINGS_VIEW_SOURCE).toMatch(/<style src="\.\.\/components\/settings\/settingsForms\.css"><\/style>/)
    const shared = ['.toggle-card', '.form-actions', '.cookies-status', '.config-panel-head', '.field-row', '.info-icon', '.info-item label']
    const copies = []
    for (const [path, source] of Object.entries(SETTINGS_SECTION_SOURCES)) {
      const css = source.split('<style')[1] || ''
      for (const selector of shared) {
        // Top-level rules only: a section may still adjust a shared rule inside @media.
        const rule = new RegExp(`\\n${selector.replace('.', '\\.')}\\s*[,{]`)
        if (rule.test(css)) copies.push(`${path} ${selector}`)
      }
    }
    expect(copies).toEqual([])
  })
})
