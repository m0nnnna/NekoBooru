import { siteById } from './types.js'

// Header texts for a booru section of the home grid (section 3.10 of
// docs/booru-search-plan.md), from one useRemoteResults section. Kept out of
// the components so grouped sections and the interleaved status strip agree.

function approx(section) {
  return section.totalIsEstimate ? '~' : ''
}

// '20 of ~1,234 posts' / '20 posts'
export function countLabel(section) {
  const shown = section.posts.length
  if (section.total === null || section.total === undefined) return `${shown} post${shown === 1 ? '' : 's'}`
  return `${shown} of ${approx(section)}${section.total.toLocaleString('en-US')} posts`
}

// 'page 2 of ~40' / 'page 2' / '' before the first page arrives.
export function pageLabel(section) {
  if (!section.page) return ''
  if (section.totalPages === null || section.totalPages === undefined) return `page ${section.page}`
  return `page ${section.page} of ${approx(section)}${section.totalPages.toLocaleString('en-US')}`
}

// Query terms the booru did not get. The translation note already names the
// terms a term budget cut, so those are not repeated.
export function ignoredLabel(section) {
  const note = section.note || ''
  const terms = (section.ignoredTerms || []).filter((term) => term && !note.includes(term))
  return terms.length ? `Ignored here: ${terms.join(', ')}` : ''
}

export function waitingLabel(section) {
  const seconds = Math.ceil((section.waitingMs || 0) / 1000)
  return seconds > 0 ? `Waiting ${seconds} s for the rate limit` : ''
}

// '40 fetched, 0 match the rating filter' once the rating checkboxes hid posts.
export function filteredLabel(section) {
  if (!section.ratingFiltered) return ''
  return `${section.fetched} fetched, ${section.posts.length} match the rating filter`
}

export function errorLabel(section) {
  const error = section.error
  if (!error) return ''
  const label = siteById(section.site)?.label || section.site
  switch (error.kind) {
    case 'throttled':
      return `${label} is rate limiting requests.`
    case 'credentials':
      return 'Gelbooru needs an API key in Settings.'
    case 'disabled':
      return 'Booru search is switched off.'
    case 'network':
      return `Could not reach ${label}.`
    case 'unavailable':
      return `${label} is unavailable right now.`
    default:
      return error.message || `${label} request failed.`
  }
}
