import { afterEach, describe, expect, it, vi } from 'vitest'

import api from './client'

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
