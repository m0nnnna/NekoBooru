import { afterEach, describe, expect, it, vi } from 'vitest'

import api, { api as namedApi } from './client'
import { authApi } from './auth.js'
import { autoTagsApi } from './autoTags.js'
import { booruSearchApi } from './booruSearch.js'
import { postsApi } from './posts.js'
import { ApiError } from './request.js'
import { settingsApi } from './settings.js'
import { tagsApi } from './tags.js'
import { uploadsApi } from './uploads.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API request errors', () => {
  async function failure(fetchImpl, call = () => api.getPosts()) {
    vi.stubGlobal('fetch', vi.fn(fetchImpl))
    try {
      await call()
    } catch (error) {
      return error
    }
    throw new Error('the request did not fail')
  }

  function errorResponse(status, body, headers = {}) {
    return {
      ok: false,
      status,
      headers: new Headers(headers),
      json: vi.fn().mockResolvedValue(body),
    }
  }

  it('types an HTTP error and reads Retry-After from the response header', async () => {
    const detail = { code: 'upstream_throttled', message: 'slow down' }
    const error = await failure(async () => errorResponse(429, { detail }, { 'Retry-After': '12' }))
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'http', status: 429, detail, retryAfterMs: 12000, message: 'slow down' })
  })

  it("falls back to the relay detail's retryAfter seconds", async () => {
    const error = await failure(async () => errorResponse(503, { detail: { code: 'upstream_throttled', retryAfter: 30 } }))
    expect(error).toMatchObject({ kind: 'http', status: 503, retryAfterMs: 30000 })
    const plain = await failure(async () => errorResponse(500, { detail: 'boom' }))
    expect(plain).toMatchObject({ kind: 'http', status: 500, retryAfterMs: null, message: 'boom' })
  })

  it('types any fetch TypeError as a network failure, whatever the browser calls it', async () => {
    const error = await failure(async () => { throw new TypeError('Load failed') })
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'network', status: null, retryAfterMs: null })
    expect(error.message).toContain('Backend server is not running')
  })

  it('types an abort and keeps the AbortError name callers check', async () => {
    const error = await failure(async () => { throw new DOMException('The operation was aborted.', 'AbortError') })
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'aborted', name: 'AbortError', status: null })
  })
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
  'publishUploadJob', 'removePostFromPool', 'renderUploadJob', 'resolveE621Name', 'resolveSankakuName', 'restartApp', 'restorePost',
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
