import { SITES } from '../types.js'
import { danbooruAdapter } from './danbooru.js'
import { e621Adapter } from './e621.js'
import { gelbooruAdapter } from './gelbooru.js'
import { safebooruAdapter } from './safebooru.js'
import { sankakuAdapter } from './sankaku.js'

// Every booru adapter by SITES id (section 3.5 of docs/booru-search-plan.md).
// The results composable and the import queue take this map as their default.
export const ADAPTERS = Object.freeze({
  danbooru: danbooruAdapter,
  e621: e621Adapter,
  sankaku: sankakuAdapter,
  gelbooru: gelbooruAdapter,
  safebooru: safebooruAdapter,
})

// Fail at import time rather than at the first search when the registry and
// the SITES list drift apart.
for (const site of SITES) {
  if (ADAPTERS[site.id]?.id !== site.id) throw new Error(`No adapter registered for booru site ${site.id}`)
}

export function adapterFor(site) {
  return Object.hasOwn(ADAPTERS, site) ? ADAPTERS[site] : null
}
