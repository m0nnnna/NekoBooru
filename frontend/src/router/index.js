import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { installHomeKeepAlive } from './homeKeepAlive'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/admin/users',
    name: 'admin-users',
    component: () => import('../views/AdminUsersView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
  },
  {
    path: '/post/:id',
    name: 'post',
    component: () => import('../views/PostView.vue'),
  },
  {
    // A booru search result on the post page; only for users who may browse boorus.
    path: '/booru/:site/:id',
    name: 'booru-post',
    component: () => import('../views/BooruPostView.vue'),
    meta: { requiresBooru: true },
  },
  {
    path: '/tags',
    name: 'tags',
    component: () => import('../views/TagsView.vue'),
  },
  {
    path: '/pools',
    name: 'pools',
    component: () => import('../views/PoolsView.vue'),
  },
  {
    path: '/pool/:id',
    name: 'pool',
    component: () => import('../views/PoolView.vue'),
  },
  {
    path: '/upload',
    name: 'upload',
    component: () => import('../views/UploadView.vue'),
  },
  {
    path: '/stats',
    name: 'stats',
    component: () => import('../views/StatsView.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const authStore = useAuthStore()

  // main.js resolves this once before the app mounts; guard against a
  // reload racing that init by resolving it here too if it somehow hasn't.
  if (!authStore.resolved) {
    await authStore.init()
  }

  if (to.meta.public) {
    return true
  }

  if (!authStore.isAuthenticated) {
    return { name: 'login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : undefined }
  }

  if (to.meta.requiresAdmin && !authStore.isAdmin) {
    return { name: 'home' }
  }

  if (to.meta.requiresBooru && !authStore.canBrowseBoorus) {
    return { name: 'home' }
  }

  return true
})

installHomeKeepAlive(router)

export default router
