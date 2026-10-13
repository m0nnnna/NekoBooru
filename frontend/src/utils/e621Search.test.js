// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ default: {} }))

import { e621FallbackUrl, e621SearchUrl, openE621Search } from './e621Search.js'

const yui = { name: 'hirasawa_yui', displayName: 'hirasawa yui' }
const leftClick = () => ({ button: 0, preventDefault: vi.fn() })

describe('e621SearchUrl', () => {
  it('links the stored e621 name, else the booru spelling', () => {
    expect(e621SearchUrl('yui_hirasawa')).toBe('https://e621.net/posts?tags=yui_hirasawa')
    expect(e621FallbackUrl({ ...yui, e621Name: 'yui_hirasawa' })).toBe('https://e621.net/posts?tags=yui_hirasawa')
    expect(e621FallbackUrl({ name: 'honoka_doa', displayName: 'honoka (doa)' })).toBe(
      'https://e621.net/posts?tags=honoka_(doa)',
    )
  })
})

describe('openE621Search', () => {
  it('resolves the name on a plain click and points the new tab at it', async () => {
    const tab = { location: { href: '' }, opener: 'page' }
    const resolveName = vi.fn(async () => ({ e621Name: 'yui_hirasawa', found: true }))
    const event = leftClick()

    const name = await openE621Search(event, yui, { openWindow: () => tab, resolveName })

    expect(event.preventDefault).toHaveBeenCalled()
    expect(resolveName).toHaveBeenCalledWith('hirasawa_yui')
    expect(tab.location.href).toBe('https://e621.net/posts?tags=yui_hirasawa')
    expect(tab.opener).toBe(null)
    expect(name).toBe('yui_hirasawa')
  })

  it('falls back to the booru spelling when the lookup fails', async () => {
    const tab = { location: { href: '' } }
    const name = await openE621Search(leftClick(), yui, {
      openWindow: () => tab,
      resolveName: async () => { throw new Error('offline') },
    })
    expect(tab.location.href).toBe('https://e621.net/posts?tags=hirasawa_yui')
    expect(name).toBe('hirasawa_yui')
  })

  it('leaves known names and modified clicks to the link itself', async () => {
    const resolveName = vi.fn()
    const known = await openE621Search(leftClick(), { ...yui, e621Name: 'yui_hirasawa' }, { resolveName })
    const ctrl = { button: 0, ctrlKey: true, preventDefault: vi.fn() }
    await openE621Search(ctrl, yui, { resolveName })
    expect(known).toBe('yui_hirasawa')
    expect(resolveName).not.toHaveBeenCalled()
    expect(ctrl.preventDefault).not.toHaveBeenCalled()
  })
})
