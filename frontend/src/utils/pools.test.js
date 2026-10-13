import { describe, expect, it, vi } from 'vitest'
import { loadAllPools } from './pools.js'

const pool = (id) => ({ id, name: `Pool ${id}` })

describe('loadAllPools', () => {
  it('stops on a short page when the total is missing', async () => {
    const api = { getPools: vi.fn(async ({ page }) => ({ results: page === 1 ? [pool(1), pool(2)] : [pool(3)] })) }
    expect((await loadAllPools(api, { pageSize: 2 })).map((p) => p.id)).toEqual([1, 2, 3])
    expect(api.getPools).toHaveBeenCalledTimes(2)
  })

  it('drops a pool that shifted onto the next page and honours the page guard', async () => {
    const api = { getPools: vi.fn(async ({ page }) => ({ results: [pool(page), pool(page + 1)], total: 99 })) }
    expect((await loadAllPools(api, { pageSize: 2, maxPages: 3 })).map((p) => p.id)).toEqual([1, 2, 3, 4])
    expect(api.getPools).toHaveBeenCalledTimes(3)
  })
})
