// Account & Sharing: who this library is shared with, and API tokens.
import { ref } from 'vue'
import api from '../api/client'

export function useSettingsAccount() {
  const directoryUsernames = ref([])
  const shareSelection = ref([])
  const sharedWithMe = ref([])
  const sharesSaving = ref(false)
  const sharesMessage = ref('')
  const apiTokens = ref([])
  const newTokenLabel = ref('')
  const newRawToken = ref('')
  const tokenCreating = ref(false)

  async function loadAccountSharing() {
    try {
      const [directory, shares, me, tokens] = await Promise.all([
        api.getDirectory(),
        api.getShares(),
        api.getMe(),
        api.getApiTokens(),
      ])
      directoryUsernames.value = directory
      shareSelection.value = shares.sharedByMe || []
      sharedWithMe.value = me.sharedWithMe || []
      apiTokens.value = tokens
    } catch (err) {
      // Settings page still works even if this section's fetch fails.
      console.error('Failed to load account/sharing settings', err)
    }
  }

  async function saveShares() {
    sharesSaving.value = true
    sharesMessage.value = ''
    try {
      await api.setShares(shareSelection.value)
      sharesMessage.value = 'Sharing updated.'
    } catch (err) {
      sharesMessage.value = err.message || 'Failed to update sharing'
    } finally {
      sharesSaving.value = false
    }
  }

  async function createToken() {
    if (!newTokenLabel.value.trim()) return
    tokenCreating.value = true
    try {
      const created = await api.createApiToken(newTokenLabel.value.trim())
      newRawToken.value = created.token
      newTokenLabel.value = ''
      apiTokens.value = await api.getApiTokens()
    } catch (err) {
      sharesMessage.value = err.message || 'Failed to create token'
    } finally {
      tokenCreating.value = false
    }
  }

  async function revokeToken(id) {
    try {
      await api.deleteApiToken(id)
      apiTokens.value = await api.getApiTokens()
    } catch (err) {
      sharesMessage.value = err.message || 'Failed to revoke token'
    }
  }

  function formatDate(value) {
    if (!value) return ''
    return new Date(value).toLocaleDateString()
  }
  return {
    directoryUsernames,
    shareSelection,
    sharedWithMe,
    sharesSaving,
    sharesMessage,
    apiTokens,
    newTokenLabel,
    newRawToken,
    tokenCreating,
    loadAccountSharing,
    saveShares,
    createToken,
    revokeToken,
    formatDate,
  }
}
