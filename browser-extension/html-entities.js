// The extension's one HTML-entity decoder. The Gelbooru engine's dapi JSON
// (Gelbooru, Safebooru and their clones) HTML-escapes tag text, e.g.
// 'girls&#039;_frontline' and '&gt;_&lt;'; decode before a tag is normalized,
// or it flattens to junk like girls_039_frontline.
//
// Loaded as a plain script before booru-tags.js and site-import-core.js
// (manifest content scripts, background.js importScripts, upload.html,
// site-import.html) and by require() under Node tests. No DOM or chrome.*.
;(function installHtmlEntities(root) {
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

  function decodeHtmlEntities(raw) {
    return String(raw || '').replace(/&(?:#(x[0-9a-f]+|\d+)|(amp|lt|gt|quot|apos));/gi, (match, num, name) => {
      if (name) return NAMED[name.toLowerCase()]
      const code = Number(/^x/i.test(num) ? `0${num}` : num)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
  }

  const api = { decodeHtmlEntities }
  root.NekoBooruEntities = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
