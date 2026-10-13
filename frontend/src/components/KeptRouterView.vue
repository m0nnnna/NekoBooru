<template>
  <router-view v-slot="{ Component }">
    <keep-alive :include="keepHome ? KEPT : NONE">
      <component :is="Component" />
    </keep-alive>
  </router-view>
</template>

<script setup>
import { keepHome } from '../router/homeKeepAlive'

// The app's router view. Only HomeView is ever cached, and only while
// keepHome says so (router/homeKeepAlive.js); dropping it from `include`
// unmounts the cached instance.
const KEPT = ['HomeView']
const NONE = []
</script>
