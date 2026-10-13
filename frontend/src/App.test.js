// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import App from './App.vue'
import APP_SOURCE from './App.vue?raw'
import PICKER_SOURCE from './components/remote/SourcePicker.vue?raw'
import { useAuthStore } from './stores/auth'

async function mountApp() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'home', component: { template: '<div class="page">page</div>' } }],
  })
  router.push('/')
  await router.isReady()
  const pinia = createPinia()
  const wrapper = mount(App, {
    attachTo: document.body,
    global: {
      plugins: [pinia, router],
      stubs: { SearchBar: true, SourcePicker: true, BackendStatus: true },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark-mode')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('App theme root', () => {
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

// jsdom has no layout, so these pin the breakpoints the browser check measured
// (an admin with a long name and the booru picker): logo 140px + nav 543px,
// then search, picker, user, Log out and toggle ~675px, ~1460px in all.
// Below the nav breakpoint only the logo, search, picker icon and menu button
// stay in the header; below the compact one the user name and picker label go.
function breakpointHiding(source, selector) {
  const widths = []
  const media = /@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g
  const escaped = selector.replace(/\./g, '\\.')
  const rule = new RegExp(`(^|,)\\s*${escaped}\\s*(,[^{]*)?\\{\\s*display: none`, 'm')
  for (const [, width, body] of source.matchAll(media)) {
    if (rule.test(body)) widths.push(Number(width))
  }
  return Math.max(0, ...widths)
}

describe('App header at narrow desktop widths', () => {
  it('collapses the nav, Log out and theme toggle into the menu by 1280px', () => {
    expect(breakpointHiding(APP_SOURCE, '.desktop-nav')).toBeGreaterThanOrEqual(1280)
    expect(breakpointHiding(APP_SOURCE, '.header-logout')).toBeGreaterThanOrEqual(1280)
    expect(breakpointHiding(APP_SOURCE, '.desktop-theme-toggle')).toBeGreaterThanOrEqual(1280)
  })

  it('drops the user name and the picker label before the header runs out of room', () => {
    expect(breakpointHiding(APP_SOURCE, '.current-user')).toBeGreaterThanOrEqual(1500)
    expect(breakpointHiding(PICKER_SOURCE, '.source-label')).toBeGreaterThanOrEqual(1500)
  })

  it('names the signed-in user in the menu once the header hides it', async () => {
    const wrapper = await mountApp()
    useAuthStore().user = { id: 1, username: 'neko', isAdmin: false }
    await flushPromises()
    expect(wrapper.get('.mobile-menu .mobile-menu-user').text()).toContain('neko')
    wrapper.unmount()
  })
})
