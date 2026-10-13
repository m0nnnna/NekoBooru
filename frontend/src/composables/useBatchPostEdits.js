import { ref, computed } from 'vue'
import { api } from '../api/client'

// Direct edits to the selected library posts: bulk tag/rating changes,
// adding to a pool, and soft-delete.
export function useBatchPostEdits({ selection, operations, browser }) {
  const { selectMode, selectedIds, selectedItems, clearSelection } = selection
  const {
    busy,
    showMessage,
    beginBatchOperation,
    updateBatchOperation,
    completeBatchOperation,
    failBatchOperation,
  } = operations
  const { fetchPosts, updateLocalPost } = browser

  // --- Tags & rating ---
  const batchTagMode = ref('add')
  const batchTags = ref([])
  const batchSafety = ref('')

  function parseBatchTags() {
    const seen = new Set()
    return (batchTags.value || [])
      .map((tag) => String(tag).trim().toLowerCase().replace(/\s+/g, '_'))
      .filter((tag) => {
        if (!tag || seen.has(tag)) return false
        seen.add(tag)
        return true
      })
  }

  function batchTagsForPost(post, tags) {
    const existing = Array.isArray(post.tags) ? post.tags : []
    const incoming = tags || []
    if (batchTagMode.value === 'add') return [...new Set([...existing, ...incoming])]
    if (batchTagMode.value === 'remove') {
      const remove = new Set(incoming)
      return existing.filter((tag) => !remove.has(tag))
    }
    if (batchTagMode.value === 'replace') return incoming
    if (batchTagMode.value === 'clear') return []
    return existing
  }

  function applyBatchUpdateToLocalPosts({ tags, willChangeTags, willChangeSafety }) {
    for (const post of selectedItems.value) {
      updateLocalPost(post.id, {
        ...(willChangeTags ? { tags: batchTagsForPost(post, tags) } : {}),
        ...(willChangeSafety ? { safety: batchSafety.value } : {}),
      })
    }
  }

  async function applyBatchUpdateIndividually({ tags, willChangeTags, willChangeSafety }) {
    const selectedPosts = selectedItems.value
    if (selectedPosts.length !== selectedIds.value.length) {
      throw new Error('Some selected posts are no longer visible. Clear selection and select them again.')
    }

    let updated = 0
    for (const post of selectedPosts) {
      const data = {}
      if (willChangeTags) data.tags = batchTagsForPost(post, tags)
      if (willChangeSafety) data.safety = batchSafety.value
      await api.updatePost(post.id, data)
      updateLocalPost(post.id, data)
      updated += 1
      updateBatchOperation(
        `Updated ${updated} / ${selectedPosts.length} selected post(s).`,
        Math.round((updated / selectedPosts.length) * 88),
      )
    }
    return { updated }
  }

  async function applyBatchTagUpdate() {
    if (!selectedIds.value.length || busy.value) return
    const tags = parseBatchTags()
    const willChangeTags = batchTagMode.value === 'clear' || tags.length > 0
    const willChangeSafety = Boolean(batchSafety.value)
    if (!willChangeTags && !willChangeSafety) {
      showMessage('Choose tags or a safety rating before applying.', 'error')
      return
    }
    if (batchTagMode.value === 'replace' && !confirm(`Replace all tags on ${selectedIds.value.length} selected post(s)?`)) return
    if (batchTagMode.value === 'clear' && !confirm(`Clear every tag from ${selectedIds.value.length} selected post(s)?`)) return
    busy.value = true
    try {
      beginBatchOperation('Applying tag and rating changes', 'Validating selected posts and requested changes.')
      let result
      try {
        result = await api.bulkUpdatePosts({
          postIds: [...selectedIds.value],
          tagMode: willChangeTags ? batchTagMode.value : null,
          tags,
          safety: batchSafety.value || null,
        })
      } catch (e) {
        if (!String(e.message || '').toLowerCase().includes('not found')) throw e
        updateBatchOperation('Bulk route is not available on this backend yet. Falling back to per-post updates.', 18)
        result = await applyBatchUpdateIndividually({ tags, willChangeTags, willChangeSafety })
      }
      applyBatchUpdateToLocalPosts({ tags, willChangeTags, willChangeSafety })
      if (selectMode.value) {
        updateBatchOperation('Keeping the current edit view and selection for your next operation.', 88)
      } else {
        updateBatchOperation('Refreshing the current page with updated tags and ratings.', 82)
        await fetchPosts()
      }
      completeBatchOperation(
        selectMode.value
          ? `Updated ${result.updated} post(s). Selection is still active for another operation.`
          : `Updated ${result.updated} selected post(s).`,
        result.updated,
      )
      showMessage(`Updated ${result.updated} selected post(s).`)
    } catch (e) {
      failBatchOperation(e.message)
      showMessage(`Batch update failed: ${e.message}`, 'error')
    } finally {
      busy.value = false
    }
  }

  async function clearTagsSelected() {
    if (!selectedIds.value.length || busy.value) return
    const previousMode = batchTagMode.value
    batchTagMode.value = 'clear'
    await applyBatchTagUpdate()
    batchTagMode.value = previousMode
  }

  // --- Add to pool ---
  const poolModalOpen = ref(false)
  const pools = ref([])
  const chosenPoolId = ref('')
  const newPoolName = ref('')

  const canConfirmPool = computed(() => {
    if (chosenPoolId.value === '__new__') return newPoolName.value.trim().length > 0
    return Boolean(chosenPoolId.value)
  })

  async function openPoolModal() {
    if (!selectedIds.value.length) return
    chosenPoolId.value = ''
    newPoolName.value = ''
    try {
      const res = await api.getPools({ limit: 100 })
      pools.value = res.results || []
    } catch {
      pools.value = []
    }
    poolModalOpen.value = true
  }

  async function confirmAddToPool() {
    if (!canConfirmPool.value || busy.value) return
    busy.value = true
    try {
      beginBatchOperation('Adding selected posts to pool', 'Preparing pool selection.', selectedIds.value.length)
      let poolId = chosenPoolId.value
      let poolName = ''
      if (poolId === '__new__') {
        updateBatchOperation('Creating the new pool.', 35)
        const created = await api.createPool({ name: newPoolName.value.trim() })
        poolId = created.id
        poolName = created.name
      } else {
        poolId = Number(poolId)
        poolName = pools.value.find((p) => p.id === poolId)?.name || 'pool'
      }
      updateBatchOperation(`Adding ${selectedIds.value.length} post(s) to "${poolName}".`, 65)
      await api.addPostsToPool(poolId, [...selectedIds.value])
      completeBatchOperation(`Added ${selectedIds.value.length} post(s) to "${poolName}". Selection is still active.`)
      showMessage(`Added ${selectedIds.value.length} post(s) to "${poolName}".`)
      poolModalOpen.value = false
    } catch (e) {
      failBatchOperation(e.message)
      showMessage(`Add to pool failed: ${e.message}`, 'error')
    } finally {
      busy.value = false
    }
  }

  // --- Delete ---
  async function deleteSelected() {
    if (!selectedIds.value.length || busy.value) return
    if (!confirm(`Delete ${selectedIds.value.length} selected post(s)? They are soft-deleted and hidden from search.`)) {
      return
    }
    busy.value = true
    try {
      beginBatchOperation('Deleting selected posts', 'Soft-deleting selected posts from search results.', selectedIds.value.length)
      const res = await api.bulkDeletePosts([...selectedIds.value])
      if (selectMode.value) {
        updateBatchOperation('Keeping the current edit view. Deleted posts will disappear after you leave or refresh.', 82)
      } else {
        updateBatchOperation('Refreshing the current page after delete.', 82)
        await fetchPosts()
      }
      completeBatchOperation(`Deleted ${res.deleted} selected post(s).`, res.deleted)
      showMessage(`Deleted ${res.deleted} post(s).`)
      clearSelection()
    } catch (e) {
      failBatchOperation(e.message)
      showMessage(`Delete failed: ${e.message}`, 'error')
    } finally {
      busy.value = false
    }
  }

  return {
    batchTagMode,
    batchTags,
    batchSafety,
    applyBatchTagUpdate,
    clearTagsSelected,
    poolModalOpen,
    pools,
    chosenPoolId,
    newPoolName,
    canConfirmPool,
    openPoolModal,
    confirmAddToPool,
    deleteSelected,
  }
}
