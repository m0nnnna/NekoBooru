import { ref } from 'vue'

// The home view stays alive (KeptRouterView's KeepAlive) while the user is on
// a booru post opened from it, so Back finds the same booru pages, scroll,
// selection and running Import-card queue, as the old overlay viewer did.
// It is kept only when home is left for a booru post, stays kept through
// library posts reached from there (View in library), and is dropped (its
// results disposed, its queue cancelled) on any other route, logout included.
export const keepHome = ref(false)

const KEPT_THROUGH = new Set(['home', 'booru-post', 'post'])

export function installHomeKeepAlive(router) {
  router.afterEach((to, from, failure) => {
    if (failure) return
    // KeepAlive caches only what `include` matched while it was shown, so
    // home is cacheable whenever it is open and dropped as it is left for
    // anything but a booru post.
    if (to.name === 'home') keepHome.value = true
    else if (from.name === 'home') keepHome.value = to.name === 'booru-post'
    else if (!KEPT_THROUGH.has(to.name)) keepHome.value = false
  })
}
