import AI_MODEL_REGISTRY from './aiModelRegistry.fixture.json'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Saved defaults whose Anime stack turns on a flag none of the view copies of
// the model list knew about when they were written (booru lookup).
const ANIME = {
  wdEnabled: false,
  pixaiEnabled: true,
  characterModelEnabled: true,
  clEnabled: true,
  booruLookupEnabled: true,
  qwenEnabled: false,
  ocrEnabled: true,
  whisperEnabled: true,
}

vi.mock('../api/client', () => {
  const api = {
    getAutoTagSettings: vi.fn(async () => ({ enabled: true, semanticModelId: 'qwen', booruLookupEnabled: false })),
    getAutoTagStatus: vi.fn(async () => ({ enabled: true, models: [] })),
    getAiModelDefaults: vi.fn(async () => ({
      modelDefaults: { wdEnabled: true, booruLookupEnabled: false, profileDefaults: { anime: ANIME } },
    })),
    getAutoTagRegistry: vi.fn(async () => AI_MODEL_REGISTRY),
    createAutoTagJob: vi.fn(async () => ({ total: 1 })),
  }
  return { api, default: api }
})

import { api } from '../api/client'
import { useUploadAiProfiles } from './useUploadAiProfiles'
import { useBatchAiTagging } from './useBatchAiTagging'
import { autoTagProfileSettings, normalizeAiProfileDefaults } from './usePostPageAiModels'
import { loadAiModelRegistry } from './useAiModelRegistry'

const IMAGE_UPLOAD = { file: { type: 'image/png', name: 'a.png' }, tags: [], safety: 'safe' }

describe('every surface runs the whole saved profile stack', () => {
  beforeEach(async () => {
    api.createAutoTagJob.mockClear()
    await loadAiModelRegistry()
  })

  it('upload preview', async () => {
    const ai = useUploadAiProfiles()
    await ai.loadAiEnabled()
    const settings = ai.uploadAiRunSettings(IMAGE_UPLOAD, 'anime')
    expect(settings.booruLookupEnabled).toBe(true)
    expect(settings.clEnabled).toBe(true)
  })

  it('batch AI tagging', async () => {
    const batch = useBatchAiTagging({
      selection: { selectedIds: ref([1]), selectedItems: ref([{ id: 1, extension: '.png' }]) },
      operations: {
        busy: ref(false),
        showMessage: vi.fn(),
        beginBatchOperation: vi.fn(),
        failBatchOperation: vi.fn(),
        trackAutoJob: vi.fn(),
      },
    })
    await batch.loadBatchAiSettings()
    batch.batchAiProfile.value = 'anime'
    await batch.runBatchAutoTag(true)
    const { settings } = api.createAutoTagJob.mock.calls[0][0]
    expect(settings.booruLookupEnabled).toBe(true)
    expect(settings.clEnabled).toBe(true)
  })

  it('post preview', async () => {
    const saved = (await api.getAiModelDefaults()).modelDefaults
    const settings = autoTagProfileSettings('anime', {
      isVideo: false,
      savedProfileDefaults: normalizeAiProfileDefaults(saved.profileDefaults, saved),
      postSettings: {},
      savedSettings: { semanticModelId: 'qwen' },
    })
    expect(settings.booruLookupEnabled).toBe(true)
    expect(settings.clEnabled).toBe(true)
  })
})
