import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import TAG_EDITOR from './PostTagEditorModal.vue?raw'

// Read from disk: Vitest hands CSS imports, ?raw included, over as empty.
const MODAL_CSS = readFileSync(new URL('./postModal.css', import.meta.url), 'utf8')

// The rules outside any @media block, by selector.
function baseRules(css) {
  const rules = new Map()
  let depth = 0
  let selector = ''
  let body = ''
  for (const part of css.replace(/\/\*[\s\S]*?\*\//g, '').split(/([{}])/)) {
    if (part === '{') {
      depth += 1
      if (depth === 1 && !selector.trim().startsWith('@')) body = ''
    } else if (part === '}') {
      if (depth === 1 && !selector.trim().startsWith('@')) rules.set(selector.trim(), body.trim())
      depth -= 1
      selector = ''
    } else if (depth === 0) {
      selector = part
    } else if (depth === 1) {
      body = part
    }
  }
  return rules
}

describe('post page dialog frame', () => {
  const rules = baseRules(MODAL_CSS)

  it('caps every dialog at the viewport height on every screen size, not only on mobile', () => {
    expect(rules.get('.modal')).toMatch(/max-height:\s*90vh/)
    expect(rules.get('.modal')).toMatch(/overflow-y:\s*auto/)
  })

  it('keeps the title and actions of a split dialog in place and scrolls only its body', () => {
    expect(rules.get('.modal.modal-split')).toMatch(/display:\s*flex/)
    expect(rules.get('.modal.modal-split')).toMatch(/flex-direction:\s*column/)
    expect(rules.get('.modal.modal-split')).toMatch(/overflow:\s*hidden/)
    expect(rules.get('.modal-split > h2,\n.modal-split > .modal-actions')).toMatch(/flex:\s*none/)
    const body = rules.get('.modal-split > .modal-body')
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  it('puts the tag editor chips and input in the scrolling body, between the title and the actions', () => {
    const template = TAG_EDITOR.split('<script')[0]
    expect(template).toMatch(/<div class="modal modal-split">\s*<h2>Edit Tags<\/h2>\s*<div class="modal-body">/)
    const body = template.slice(template.indexOf('<div class="modal-body">'), template.indexOf('<div class="modal-actions">'))
    expect(body).toContain('<TagInput')
    expect(body).toContain('class="raw-tag-editor"')
  })
})
