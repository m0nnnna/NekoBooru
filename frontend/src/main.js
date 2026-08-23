import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'

const app = createApp(App)

app.use(createPinia())
app.use(router)

const authStore = useAuthStore()

window.addEventListener('neko:unauthorized', () => {
  authStore.clear()
  if (router.currentRoute.value.name !== 'login') {
    router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
  }
})

// Resolve auth state before the router's first navigation, so the
// beforeEach guard already knows whether to allow it through.
authStore.init().finally(() => {
  app.mount('#app')
})
