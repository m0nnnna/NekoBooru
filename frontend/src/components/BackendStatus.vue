<template>
  <div v-if="!isConnected" class="backend-status">
    <div class="status-banner">
      <span class="status-icon">⚠️</span>
      <div class="status-content">
        <strong>(=;&#x2D8;;=) Backend server is not running</strong>
        <p>Please start the backend server on port 8000 to use this application.</p>
        <div class="status-actions">
          <button class="btn btn-sm" @click="checkConnection">Retry Connection</button>
          <a href="http://localhost:8000/docs" target="_blank" class="btn btn-sm btn-secondary">
            Open API Docs
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import api from '../api/client'

const isConnected = ref(true)
let checkInterval = null

async function checkConnection() {
  try {
    await api.checkHealth()
    isConnected.value = true
  } catch (e) {
    isConnected.value = false
  }
}

onMounted(() => {
  checkConnection()
  // Check every 5 seconds
  checkInterval = setInterval(checkConnection, 5000)
})

onUnmounted(() => {
  if (checkInterval) {
    clearInterval(checkInterval)
  }
})
</script>

<style scoped>
.backend-status {
  position: fixed;
  top: 60px;
  left: 0;
  right: 0;
  z-index: 1000;
  padding: 1rem;
  animation: slideDown 0.3s ease-out;
}

@keyframes slideDown {
  from {
    transform: translateY(-100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.status-banner {
  max-width: 1600px;
  margin: 0 auto;
  background: var(--warning);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1rem 1.5rem;
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  box-shadow: 0 4px 12px var(--shadow-lg);
}

.status-icon {
  font-size: 1.5rem;
  flex-shrink: 0;
}

.status-content {
  flex: 1;
}

.status-content strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 0.5rem;
  font-size: 1rem;
}

.status-content p {
  color: var(--text-secondary);
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
}

.status-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.status-actions .btn {
  font-size: 0.85rem;
  padding: 0.4rem 0.9rem;
}
</style>
