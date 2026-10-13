<template>
  <div v-if="authStore.isAdmin" class="booru-search-admin-card">
    <label class="toggle-card" :class="{ busy: loading || saving }">
      <input
        type="checkbox"
        :checked="enabled"
        :disabled="loading || saving"
        @change="onToggle($event.target.checked)"
      />
      <span>
        <strong>
          Enable booru search
          <em class="admin-badge">Admin</em>
        </strong>
        <small>
          Lets every logged-in user search Danbooru, Gelbooru, Safebooru, e621 and Sankaku from the home
          search, next to this library, and import posts from them at original resolution with their tags.
          Off by default. While it is off, the source picker is hidden for everyone and the home page behaves
          as before.
        </small>
        <small>
          Danbooru, e621 and Sankaku are searched straight from each user's browser; Gelbooru and Safebooru
          go through this server. Gelbooru search also needs the Gelbooru API credentials saved under
          Auto Tagging → Gelbooru API credentials (shown once AI features are enabled).
        </small>
      </span>
    </label>

    <p v-if="loading" class="booru-search-note">Loading booru search setting...</p>
    <p v-else-if="saving" class="booru-search-note">Saving...</p>
    <p v-if="status.show" class="cookies-status" :class="status.success ? 'success' : 'error'" role="status">
      <strong>{{ status.message }}</strong>
    </p>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import api from '../api/client'
import { useAuthStore } from '../stores/auth'

const authStore = useAuthStore()

const enabled = ref(false)
const loading = ref(false)
const saving = ref(false)
const status = ref({ show: false, success: true, message: '' })

function errorText(error, action) {
  const reason = (error?.message || 'Request failed').replace(/\.$/, '')
  const hint = error?.status === 403 ? ' Only admin accounts can change this setting.' : ''
  return `Could not ${action} the booru search setting: ${reason}.${hint}`
}

async function load() {
  loading.value = true
  status.value = { show: false, success: true, message: '' }
  try {
    const data = await api.getBooruSearchSettings()
    enabled.value = data?.enabled === true
  } catch (error) {
    status.value = { show: true, success: false, message: errorText(error, 'load') }
  } finally {
    loading.value = false
  }
}

async function onToggle(next) {
  const previous = enabled.value
  enabled.value = next === true
  saving.value = true
  status.value = { show: false, success: true, message: '' }
  try {
    const data = await api.updateBooruSearchSettings(enabled.value)
    enabled.value = data?.enabled === true
    // The admin's own source picker reads canBrowseBoorus from /api/auth/me,
    // so refresh it here instead of waiting for the next page load.
    await authStore.fetchMe()
    status.value = {
      show: true,
      success: true,
      message: enabled.value
        ? 'Booru search enabled for every logged-in user.'
        : 'Booru search disabled. The source picker is hidden for everyone.',
    }
  } catch (error) {
    enabled.value = previous
    status.value = { show: true, success: false, message: errorText(error, 'save') }
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  if (authStore.isAdmin) load()
})
</script>

<style scoped>
.booru-search-admin-card {
  margin-top: 0.75rem;
}

.toggle-card {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.toggle-card.busy {
  opacity: 0.75;
}

.toggle-card input {
  margin-top: 0.15rem;
}

.toggle-card strong {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.2rem;
  font-size: 0.9rem;
}

.toggle-card small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.toggle-card small + small {
  margin-top: 0.35rem;
}

.admin-badge {
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: 0.68rem;
  font-style: normal;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.booru-search-note {
  margin: 0.5rem 0 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.cookies-status {
  margin: 1rem 0 0;
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
}

.cookies-status.success {
  background: var(--success-soft);
  border-color: var(--success);
  color: var(--text-primary);
}

.cookies-status.error {
  background: var(--coral-soft);
  border-color: var(--coral);
  color: var(--text-primary);
}
</style>
