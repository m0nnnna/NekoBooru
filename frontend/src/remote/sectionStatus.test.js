import { describe, expect, it } from 'vitest'
import { RemoteSearchError } from './types.js'
import { countLabel, errorLabel, filteredLabel, ignoredLabel, pageLabel, waitingLabel } from './sectionStatus.js'

function section(overrides = {}) {
  return {
    site: 'e621',
    label: 'e621 / e926',
    posts: new Array(20).fill({}),
    cursor: 2,
    loading: false,
    error: null,
    total: null,
    totalIsEstimate: false,
    page: 1,
    totalPages: null,
    ignoredTerms: [],
    note: null,
    waitingMs: 0,
    fetched: 20,
    ratingFiltered: 0,
    ...overrides,
  }
}

describe('sectionStatus', () => {
  it('counts posts and pages, marking estimates with ~', () => {
    expect(countLabel(section())).toBe('20 posts')
    expect(countLabel(section({ posts: [{}] }))).toBe('1 post')
    expect(countLabel(section({ total: 1234 }))).toBe('20 of 1,234 posts')
    expect(countLabel(section({ total: 1234, totalIsEstimate: true }))).toBe('20 of ~1,234 posts')
    expect(pageLabel(section({ page: 0 }))).toBe('')
    expect(pageLabel(section())).toBe('page 1')
    expect(pageLabel(section({ page: 2, totalPages: 17 }))).toBe('page 2 of 17')
    expect(pageLabel(section({ page: 2, totalPages: 17, totalIsEstimate: true }))).toBe('page 2 of ~17')
  })

  it('lists ignored terms the note does not already name', () => {
    expect(ignoredLabel(section())).toBe('')
    expect(ignoredLabel(section({ ignoredTerms: ['score:>5', 'cat'], note: 'Danbooru allows 2 search terms without an account; ignored: cat' })))
      .toBe('Ignored here: score:>5')
  })

  it('explains waits, rating filtering and errors', () => {
    expect(waitingLabel(section({ waitingMs: 1200 }))).toBe('Waiting 2 s for the rate limit')
    expect(waitingLabel(section())).toBe('')
    expect(filteredLabel(section({ posts: [], fetched: 40, ratingFiltered: 40 }))).toBe('40 fetched, 0 match the rating filter')
    expect(filteredLabel(section())).toBe('')
    const failed = (kind, message) => section({ error: new RemoteSearchError({ site: 'e621', kind, message }) })
    expect(errorLabel(failed('throttled'))).toBe('e621 / e926 is rate limiting requests.')
    expect(errorLabel(section({ site: 'gelbooru', error: new RemoteSearchError({ site: 'gelbooru', kind: 'credentials' }) })))
      .toBe('Gelbooru needs an API key in Settings.')
    expect(errorLabel(failed('query', 'Bad tag'))).toBe('Bad tag')
    expect(errorLabel(section())).toBe('')
  })
})
