<template>
  <div id="app" :class="{ 'dark-mode': isDarkMode }">
    <header class="app-header">
      <div class="header-left">
        <router-link to="/" class="logo">
          <span class="logo-neko">Neko</span><span class="logo-booru">Booru</span>
        </router-link>
        <nav class="main-nav">
          <router-link to="/">Posts</router-link>
          <router-link to="/tags">Tags</router-link>
          <router-link to="/pools">Pools</router-link>
          <router-link to="/upload">Upload</router-link>
          <router-link to="/settings">Settings</router-link>
        </nav>
      </div>
      <div class="header-right">
        <SearchBar />
        <button class="theme-toggle" @click="toggleDarkMode" :title="isDarkMode ? 'Light mode' : 'Dark mode'">
          {{ isDarkMode ? '&#9788;' : '&#9789;' }}
        </button>
      </div>
    </header>
    <BackendStatus />
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import SearchBar from './components/SearchBar.vue'
import BackendStatus from './components/BackendStatus.vue'

const isDarkMode = ref(true)

onMounted(() => {
  const saved = localStorage.getItem('darkMode')
  // Default to dark mode if not set
  isDarkMode.value = saved === null ? true : saved === 'true'
})

function toggleDarkMode() {
  isDarkMode.value = !isDarkMode.value
  localStorage.setItem('darkMode', isDarkMode.value)
}
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  /* Light mode - soft warm gray tones */
  --bg-body: #e8e4df;
  --bg-primary: #f5f2ed;
  --bg-secondary: #eae7e2;
  --bg-tertiary: #ddd9d3;
  --bg-card: #ffffff;
  --text-primary: #2d2a26;
  --text-secondary: #6b6560;
  --text-muted: #9a948d;

  /* Accent colors */
  --accent: #5c9ece;
  --accent-hover: #4a8bc0;
  --accent-soft: rgba(92, 158, 206, 0.15);
  --coral: #e07a5f;
  --coral-hover: #c9664a;
  --coral-soft: rgba(224, 122, 95, 0.15);
  --success: #81b29a;
  --success-hover: #6a9c84;
  --success-soft: rgba(129, 178, 154, 0.15);
  --warning: #f2cc8f;

  --border: #d4d0ca;
  --border-light: #e8e4df;
  --shadow: rgba(45, 42, 38, 0.08);
  --shadow-lg: rgba(45, 42, 38, 0.15);

  /* Tag colors - muted pastels */
  --tag-general: #5c9ece;
  --tag-artist: #e6a756;
  --tag-character: #81b29a;
  --tag-copyright: #b48ead;
  --tag-meta: #e07a5f;
}

.dark-mode {
  /* Dark mode - deep cool grays */
  --bg-body: #121417;
  --bg-primary: #1a1d21;
  --bg-secondary: #22262b;
  --bg-tertiary: #2c3138;
  --bg-card: #282c33;
  --text-primary: #e4e2df;
  --text-secondary: #a09a92;
  --text-muted: #6b665f;

  /* Accent colors - slightly brighter for dark */
  --accent: #6aadde;
  --accent-hover: #82bde8;
  --accent-soft: rgba(106, 173, 222, 0.2);
  --coral: #eb8b72;
  --coral-hover: #f09d86;
  --coral-soft: rgba(235, 139, 114, 0.2);
  --success: #8fc4aa;
  --success-hover: #a0d1b9;
  --success-soft: rgba(143, 196, 170, 0.2);
  --warning: #f5d89a;

  --border: #3a3f47;
  --border-light: #2c3138;
  --shadow: rgba(0, 0, 0, 0.3);
  --shadow-lg: rgba(0, 0, 0, 0.5);

  /* Tag colors - brighter for dark mode visibility */
  --tag-general: #7fc4f7;
  --tag-artist: #f7c97f;
  --tag-character: #9ad9b8;
  --tag-copyright: #d4a8d0;
  --tag-meta: #f7a08a;
}

html {
  background: var(--bg-body);
}

body {
  font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Oxygen, Ubuntu, sans-serif;
  background: var(--bg-body);
  color: var(--text-primary);
  line-height: 1.6;
  min-height: 100vh;
}

#app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-body);
}

a {
  color: var(--accent);
  text-decoration: none;
  transition: color 0.2s;
}

a:hover {
  color: var(--accent-hover);
}

button {
  cursor: pointer;
  font-family: inherit;
  transition: all 0.2s;
}

/* Header */
.app-header {
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border);
  padding: 0 1.5rem;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 2.5rem;
}

.logo {
  font-size: 1.35rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 0;
}

.logo:hover {
  text-decoration: none;
}

.logo-neko {
  color: var(--coral);
}

.logo-booru {
  color: var(--text-primary);
}

.main-nav {
  display: flex;
  gap: 0.25rem;
}

.main-nav a {
  color: var(--text-secondary);
  font-weight: 500;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  transition: all 0.2s;
}

.main-nav a:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.main-nav a.router-link-active {
  color: var(--accent);
  background: var(--accent-soft);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.theme-toggle {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  width: 38px;
  height: 38px;
  font-size: 1.1rem;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.theme-toggle:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

/* Main content */
.app-main {
  flex: 1;
  padding: 1.5rem;
  max-width: 1600px;
  margin: 0 auto;
  width: 100%;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  border-radius: 0.5rem;
  font-weight: 500;
  font-size: 0.9rem;
  border: none;
  background: var(--accent);
  color: white;
  transition: all 0.2s;
}

.btn:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.btn:active {
  transform: translateY(0);
}

.btn-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  background: var(--bg-secondary);
  border-color: var(--accent);
  color: var(--accent);
}

.btn-danger {
  background: var(--coral);
}

.btn-danger:hover {
  background: var(--coral-hover);
}

.btn-sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
}

/* Form elements */
input, textarea, select {
  font-family: inherit;
  font-size: 0.9rem;
  padding: 0.6rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  transition: border-color 0.2s, box-shadow 0.2s;
}

input::placeholder, textarea::placeholder {
  color: var(--text-muted);
}

input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* Cards */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 1.25rem;
}

/* Scrollbar */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: var(--bg-secondary);
}

::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 5px;
  border: 2px solid var(--bg-secondary);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

/* Selection */
::selection {
  background: var(--accent);
  color: white;
}

/* Headings */
h1, h2, h3 {
  color: var(--text-primary);
  font-weight: 600;
}

h1 { font-size: 1.75rem; }
h2 { font-size: 1.35rem; }
h3 { font-size: 1.1rem; }
</style>
