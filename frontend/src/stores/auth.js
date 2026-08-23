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

  async function login(username, password) {
    user.value = await api.login(username, password)
    hasUsers.value = true
    return user.value
  }

  async function bootstrapAdmin(username, password) {
    user.value = await api.bootstrapAdmin(username, password)
    hasUsers.value = true
    return user.value
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
    fetchStatus,
    fetchMe,
    init,
    login,
    bootstrapAdmin,
    logout,
    clear,
  }
})
