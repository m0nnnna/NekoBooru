import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Read from disk: Vitest hands CSS imports, ?raw included, over as empty.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const styles = (source) => source.split('<style').slice(1).join('<style')

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? null
}

describe('global button styles', () => {
  const app = styles(read('./App.vue'))

  it('gives every disabled .btn the greyed-out pager look', () => {
    const disabled = rule(app, '.btn:disabled')
    expect(disabled).toMatch(/opacity:\s*0\.4;/)
    expect(disabled).toMatch(/cursor:\s*not-allowed;/)
    expect(disabled).toMatch(/transform:\s*none;/)
  })

  it('does not light up a disabled button on hover', () => {
    for (const selector of ['.btn:hover:not(:disabled)', '.btn-secondary:hover:not(:disabled)', '.btn-danger:hover:not(:disabled)']) {
      expect(rule(app, selector), selector).not.toBeNull()
    }
    expect(rule(app, '.btn:hover')).toBeNull()
  })

  it('leaves no local copies of the disabled rule', () => {
    const copies = {
      'components/batch/batchForms.css': read('./components/batch/batchForms.css'),
      'components/post/PostOptimizePanel.vue': styles(read('./components/post/PostOptimizePanel.vue')),
      'components/Pagination.vue': styles(read('./components/Pagination.vue')),
    }
    const found = Object.entries(copies).filter(([, css]) => /\.btn:disabled\s*\{/.test(css)).map(([path]) => path)
    expect(found).toEqual([])
  })
})
