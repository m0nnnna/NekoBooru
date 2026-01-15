import { createRouter, createWebHistory } from 'vue-router'

const routes = [
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
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
