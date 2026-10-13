import { afterEach, describe, expect, it, vi } from 'vitest'

import api, { api as namedApi } from './client'
import { authApi } from './auth.js'
import { autoTagsApi } from './autoTags.js'
import { booruSearchApi } from './booruSearch.js'
import { postsApi } from './posts.js'
import { settingsApi } from './settings.js'
import { tagsApi } from './tags.js'
import { uploadsApi } from './uploads.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function successfulResponse(payload = {}) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(payload),
  }
}

describe('API request headers', () => {
  it('keeps JSON content type when an idempotency header is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({ id: 'job-1' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.createUploadJob({
      kind: 'local',
      filename: 'tomoko.gif',
      size: 10_000_000,
      mimeType: 'image/gif',
    }, 'request-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/upload-jobs', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'request-1',
      },
    }))

    await api.publishUploadJob('job-1', {
      artifactId: 'artifact-1',
      revision: 1,
      tags: [],
      safety: 'safe',
    }, 'request-2')

    expect(fetchMock).toHaveBeenLastCalledWith('/api/upload-jobs/job-1/publish', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'request-2',
      },
    }))
  })

  it('lets the browser set multipart boundaries for file uploads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({ token: 'upload-1' }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['GIF89a'], 'tiny.gif', { type: 'image/gif' })

    await api.uploadFile(file)

    const [, config] = fetchMock.mock.calls[0]
    expect(config.body).toBeInstanceOf(FormData)
    expect(config.headers).not.toHaveProperty('Content-Type')
  })
})

// Every method the single-file client had before the split by domain.
const METHODS = [
  'addPostsToPool', 'applyAutoTagJob', 'applyAutoTags', 'autocomplete', 'bootstrapAdmin', 'bulkDeletePosts',
  'bulkOptimizePosts', 'bulkUpdatePosts', 'cancelAiRuntimeInstall', 'cancelAutoTagJob', 'cancelAutoTagModelDownloadJob', 'cancelUploadJob',
  'checkForUpdates', 'checkHealth', 'createAlias', 'createApiToken', 'createAutoTagJob', 'createComment',
  'createImplication', 'createNote', 'createOptimizeJob', 'createPool', 'createPost', 'createTag',
  'createUploadJob', 'createUser', 'danbooruNames', 'deleteAlias', 'deleteApiToken', 'deleteAutoTagModelById',
  'deleteComment', 'deleteGelbooruCredentials', 'deleteHuggingFaceToken', 'deleteImplication', 'deleteNote', 'deletePool',
  'deletePost', 'deletePostAiAnalysis', 'deleteTag', 'deleteTaggerWorkerToken', 'deleteUploadJob', 'deleteYtdlpCookies',
  'downloadAllAutoTagModels', 'downloadAutoTagModel', 'downloadAutoTagModelById', 'estimateAutoTagJob', 'fetchFromUrl', 'gelbooruTagCategories',
  'getAiModelDefaults', 'getAiRuntimeInstallJob', 'getAiRuntimeProfiles', 'getAliases', 'getApiTokens', 'getAuthStatus',
  'getAutoTagJob', 'getAutoTagJobSuggestions', 'getAutoTagModelDownloadJob', 'getAutoTagModelLoadJob', 'getAutoTagModels', 'getAutoTagSettings',
  'getAutoTagStatus', 'getBooruSearchSettings', 'getBooruSearchStatus', 'getCategories', 'getComments', 'getCurrentAutoTagJob',
  'getDashboard', 'getDirectory', 'getDuplicateGroups', 'getExtensionSettings', 'getFromUrlProgress', 'getImplications',
  'getMe', 'getNotes', 'getOptimizeJob', 'getPool', 'getPools', 'getPost',
  'getPostAiAnalysis', 'getPostNeighbors', 'getPostOnlineMatches', 'getPosts', 'getRuntimeStatus', 'getSettings',
  'getShares', 'getSimilarPosts', 'getSimilarityBackfill', 'getStats', 'getTag', 'getTags',
  'getUpdateStatus', 'getUploadJob', 'getUsers', 'getYtdlpStatus', 'installAiRuntime', 'loadAutoTagModelById',
  'login', 'logout', 'lookupInLibrary', 'migrateData', 'previewAutoTags', 'previewUploadAutoTags',
  'publishUploadJob', 'removePostFromPool', 'renderUploadJob', 'resolveSankakuName', 'restartApp', 'restorePost',
  'retryUploadJob', 'sampleUploadJob', 'saveGelbooruCredentials', 'saveHuggingFaceToken', 'savePostAiAnalysis', 'saveTaggerWorkerToken',
  'searchGelbooru', 'searchSafebooru', 'setShares', 'startSimilarityBackfill', 'toggleFavorite', 'unloadAutoTagModelById',
  'updateAiModelDefaults', 'updateAutoTagSettings', 'updateBooruSearchSettings', 'updateComment', 'updateDataDir', 'updateExtensionSettings',
  'updateNote', 'updatePool', 'updatePost', 'updatePostAiAnalysis', 'updateServerSettings', 'updateTag',
  'updateUpdateSettings', 'updateUser', 'updateYtdlp', 'updateYtdlpSettings', 'uploadFile', 'uploadFromFediverse',
  'uploadFromUrl', 'uploadFromYtdlp', 'uploadJobContent', 'uploadYtdlpCookies',
]

describe('API client facade', () => {
  it('keeps every method, once, behind both exports', () => {
    expect(namedApi).toBe(api)
    expect(Object.keys(api).sort()).toEqual([...METHODS].sort())
    const modules = [postsApi, uploadsApi, autoTagsApi, tagsApi, settingsApi, authApi, booruSearchApi]
    const keys = modules.flatMap((module) => Object.keys(module))
    expect(keys).toHaveLength(new Set(keys).size)
  })
})
