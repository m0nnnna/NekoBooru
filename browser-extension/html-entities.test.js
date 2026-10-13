const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { decodeHtmlEntities } = require('./html-entities.js')

// Run with: node browser-extension/html-entities.test.js
// The Gelbooru engine's dapi JSON (Gelbooru, Safebooru, and its clones)
// HTML-escapes tag text. html-entities.js is the extension's one decoder for it.

assert.equal(decodeHtmlEntities('girls&#039;_frontline'), "girls'_frontline")
assert.equal(decodeHtmlEntities('&gt;_&lt; tom_&amp;_jerry'), '>_< tom_&_jerry')
assert.equal(decodeHtmlEntities('&#x27;quoted&#X27; &QUOT;x&quot; &apos;'), `'quoted' "x" '`)
assert.equal(decodeHtmlEntities('&bogus; a&b &#0; &#x110000;'), '&bogus; a&b &#0; &#x110000;')
assert.equal(decodeHtmlEntities(null), '')
assert.equal(decodeHtmlEntities(undefined), '')
assert.equal(decodeHtmlEntities(42), '42')

// One owner: the scripts that read Gelbooru-family text must not grow their
// own copy of the decoder again.
for (const file of ['site-import-core.js', 'booru-tags.js']) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
  assert.doesNotMatch(source, /&\(\?:#\(x\[0-9a-f\]/, `${file} carries its own entity decoder`)
}

console.log('html-entities tests passed')
