import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../api/client'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const hasUsers = ref(true)
  // Tracks whether fetchMe() has resolved at least once, so the router guard
  // can wait for it instead of redirecting to /login on the first render.
  const resolved = ref(false)

  const isAuthenticated = computed(() => user.value !== null)
  const isAdmin = computed(() => Boolean(user.value?.isAdmin))
  // Booru search capability from /api/auth/me; the only thing the UI reads
  // to decide whether the source picker and remote results exist at all.
  const canBrowseBoorus = computed(() => user.value?.canBrowseBoorus === true)

  async function fetchStatus() {
    const status = await api.getAuthStatus()
    hasUsers.value = status.hasUsers
    return status
  }

  async function fetchMe() {
    try {
      user.value = await api.getMe()
    } catch {
      user.value = null
    } finally {
      resolved.value = true
    }
    return user.value
  }

  async function init() {
    await fetchStatus()
    await fetchMe()
  }

  // The login answers carry the bare user; /me adds the capabilities
  // (canBrowseBoorus, shares). Keep the bare user if /me is unreachable.
  async function adoptSignedInUser(signedIn) {
    user.value = signedIn
    hasUsers.value = true
    try {
      user.value = (await api.getMe()) || signedIn
    } catch {
      // Capabilities stay off until the next fetchMe().
    }
    return user.value
  }

  async function login(username, password) {
    return adoptSignedInUser(await api.login(username, password))
  }

  async function bootstrapAdmin(username, password) {
    return adoptSignedInUser(await api.bootstrapAdmin(username, password))
  }

  async function logout() {
    try {
      await api.logout()
    } finally {
      user.value = null
    }
  }

  function clear() {
    user.value = null
  }

  return {
    user,
    hasUsers,
    resolved,
    isAuthenticated,
    isAdmin,
    canBrowseBoorus,
    fetchStatus,
    fetchMe,
    init,
    login,
    bootstrapAdmin,
    logout,
    clear,
  }
})
