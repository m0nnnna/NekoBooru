<template>
  <div class="login-view">
    <div class="login-card card">
      <div class="login-logo">
        <span class="logo-ears" aria-hidden="true"></span>
        <span class="logo-neko">Neko</span><span class="logo-booru">Booru</span>
      </div>

      <template v-if="!authStore.hasUsers">
        <h1>Create the admin account</h1>
        <p class="section-description">
          No accounts exist yet. Create the first one - it becomes the admin
          account and every post, pool, and favorite already in this library
          will be assigned to it.
        </p>
        <form @submit.prevent="handleBootstrap">
          <div class="form-group">
            <label>Username</label>
            <input v-model.trim="username" type="text" autocomplete="username" required />
          </div>
          <div class="form-group">
            <label>Password</label>
            <input v-model="password" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <p v-if="error" class="login-error">{{ error }}</p>
          <button class="btn" type="submit" :disabled="submitting">
            {{ submitting ? 'Creating…' : 'Create admin account' }}
          </button>
        </form>
      </template>

      <template v-else>
        <h1>Log in</h1>
        <form @submit.prevent="handleLogin">
          <div class="form-group">
            <label>Username</label>
            <input v-model.trim="username" type="text" autocomplete="username" required />
          </div>
          <div class="form-group">
            <label>Password</label>
            <input v-model="password" type="password" autocomplete="current-password" required />
          </div>
          <p v-if="error" class="login-error">{{ error }}</p>
          <button class="btn" type="submit" :disabled="submitting">
            {{ submitting ? 'Logging in…' : 'Log in' }}
          </button>
        </form>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const authStore = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref('')

onMounted(async () => {
  await authStore.fetchStatus()
})

async function handleBootstrap() {
  error.value = ''
  submitting.value = true
  try {
    await authStore.bootstrapAdmin(username.value, password.value)
    redirectAfterLogin()
  } catch (err) {
    error.value = err.message || 'Failed to create the admin account'
  } finally {
    submitting.value = false
  }
}

async function handleLogin() {
  error.value = ''
  submitting.value = true
  try {
    await authStore.login(username.value, password.value)
    redirectAfterLogin()
  } catch (err) {
    error.value = err.message || 'Invalid username or password'
  } finally {
    submitting.value = false
  }
}

function redirectAfterLogin() {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  router.replace(redirect)
}
</script>

<style scoped>
.login-view {
  min-height: calc(100vh - 60px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

.login-card {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.login-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  font-size: 1.5rem;
  font-weight: 700;
  margin-bottom: 0.5rem;
}

.login-view h1 {
  font-size: 1.25rem;
  text-align: center;
}

.login-view form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.login-view .form-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.login-error {
  color: var(--coral);
  font-size: 0.9rem;
  margin: 0;
}
</style>
