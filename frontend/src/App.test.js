// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import App from './App.vue'

async function mountApp() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'home', component: { template: '<div class="page">page</div>' } }],
  })
  router.push('/')
  await router.isReady()
  const wrapper = mount(App, {
    attachTo: document.body,
    global: {
      plugins: [createPinia(), router],
      stubs: { SearchBar: true, SourcePicker: true, BackendStatus: true },
    },
  })
  await flushPromises()
  return wrapper
}

describe('App theme root', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark-mode')
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('puts the dark theme on the document root so body text and teleports use it', async () => {
    const wrapper = await mountApp()
    // body's colour and anything teleported to <body> resolve the palette
    // from <html>, so the theme class has to live there, not on #app.
    expect(document.documentElement.classList.contains('dark-mode')).toBe(true)

    await wrapper.find('.desktop-theme-toggle').trigger('click')
    expect(document.documentElement.classList.contains('dark-mode')).toBe(false)
    expect(localStorage.getItem('darkMode')).toBe('false')
    wrapper.unmount()
  })

  it('restores a saved light theme', async () => {
    localStorage.setItem('darkMode', 'false')
    const wrapper = await mountApp()
    expect(document.documentElement.classList.contains('dark-mode')).toBe(false)
    wrapper.unmount()
  })
})
