<template>
  <div class="admin-users-view">
    <div class="header">
      <h1>Manage Users</h1>
      <button class="btn" @click="showCreateModal = true">Add User</button>
    </div>

    <p v-if="error" class="login-error">{{ error }}</p>

    <table class="users-table card">
      <thead>
        <tr>
          <th>Username</th>
          <th>Role</th>
          <th>Status</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>{{ u.username }}</td>
          <td>{{ u.isAdmin ? 'Admin' : 'User' }}</td>
          <td>{{ u.isActive ? 'Active' : 'Deactivated' }}</td>
          <td>{{ formatDate(u.createdAt) }}</td>
          <td class="actions">
            <button class="btn btn-secondary btn-sm" @click="openReset(u)">Reset password</button>
            <button
              class="btn btn-sm"
              :class="u.isActive ? 'btn-danger' : ''"
              :disabled="u.id === authStore.user?.id"
              @click="toggleActive(u)"
            >
              {{ u.isActive ? 'Deactivate' : 'Reactivate' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="showCreateModal" class="modal-overlay" @click.self="showCreateModal = false">
      <div class="modal">
        <h2>Add User</h2>
        <div class="form-group">
          <label>Username</label>
          <input v-model.trim="newUser.username" placeholder="Username" />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input v-model="newUser.password" type="password" placeholder="Password" minlength="8" />
        </div>
        <div class="form-group checkbox-group">
          <label><input type="checkbox" v-model="newUser.isAdmin" /> Admin</label>
        </div>
        <p v-if="createError" class="login-error">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showCreateModal = false">Cancel</button>
          <button class="btn" :disabled="!canCreate" @click="createUser">Create</button>
        </div>
      </div>
    </div>

    <div v-if="resetTarget" class="modal-overlay" @click.self="resetTarget = null">
      <div class="modal">
        <h2>Reset password for {{ resetTarget.username }}</h2>
        <div class="form-group">
          <label>New password</label>
          <input v-model="resetPassword" type="password" placeholder="New password" minlength="8" />
        </div>
        <p v-if="resetError" class="login-error">{{ resetError }}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="resetTarget = null">Cancel</button>
          <button class="btn" :disabled="resetPassword.length < 8" @click="submitReset">Reset</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../api/client'
import { useAuthStore } from '../stores/auth'

const authStore = useAuthStore()

const users = ref([])
const error = ref('')
const showCreateModal = ref(false)
const newUser = ref({ username: '', password: '', isAdmin: false })
const createError = ref('')
const resetTarget = ref(null)
const resetPassword = ref('')
const resetError = ref('')

const canCreate = computed(() => newUser.value.username.length > 0 && newUser.value.password.length >= 8)

onMounted(fetchUsers)

async function fetchUsers() {
  error.value = ''
  try {
    users.value = await api.getUsers()
  } catch (err) {
    error.value = err.message || 'Failed to load users'
  }
}

async function createUser() {
  createError.value = ''
  try {
    await api.createUser(newUser.value)
    showCreateModal.value = false
    newUser.value = { username: '', password: '', isAdmin: false }
    await fetchUsers()
  } catch (err) {
    createError.value = err.message || 'Failed to create user'
  }
}

async function toggleActive(u) {
  try {
    await api.updateUser(u.id, { isActive: !u.isActive })
    await fetchUsers()
  } catch (err) {
    error.value = err.message || 'Failed to update user'
  }
}

function openReset(u) {
  resetTarget.value = u
  resetPassword.value = ''
  resetError.value = ''
}

async function submitReset() {
  resetError.value = ''
  try {
    await api.updateUser(resetTarget.value.id, { password: resetPassword.value })
    resetTarget.value = null
  } catch (err) {
    resetError.value = err.message || 'Failed to reset password'
  }
}

function formatDate(value) {
  if (!value) return ''
  return new Date(value).toLocaleDateString()
}
</script>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.users-table {
  width: 100%;
  border-collapse: collapse;
}

.users-table th,
.users-table td {
  text-align: left;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--border);
}

.users-table .actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.login-error {
  color: var(--coral);
}

.checkbox-group label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
