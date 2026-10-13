// The one HTML-entity decoder for the frontend's Gelbooru-family adapters.
// The dapi JSON HTML-escapes tag strings and sources ('&gt;_&lt;',
// 'angel&#039;s_24_uniform_(blue_archive)', '?a=1&amp;b=2'). The browser
// extension has its own copy in browser-extension/site-import-core.js, since
// the two bundles share no code.

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}
