// Every pool for a pool picker. GET /api/pools pages at most 100 per request,
// so a single call left larger libraries' later pools unselectable.
export const POOL_PAGE_SIZE = 100
// A runaway guard, not a product limit: 50 pages is 5000 pools.
export const POOL_MAX_PAGES = 50

export async function loadAllPools(api, { pageSize = POOL_PAGE_SIZE, maxPages = POOL_MAX_PAGES } = {}) {
  const pools = []
  const seen = new Set()
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await api.getPools({ limit: pageSize, page })
    const rows = Array.isArray(data?.results) ? data.results : []
    for (const pool of rows) {
      if (pool?.id == null || seen.has(pool.id)) continue
      seen.add(pool.id)
      pools.push(pool)
    }
    const total = Number.isInteger(data?.total) ? data.total : null
    if (rows.length < pageSize || (total !== null && page * pageSize >= total)) break
  }
  return pools
}
