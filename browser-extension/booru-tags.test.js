const assert = require('node:assert/strict')
const booru = require('./booru-tags.js')

// Run with: node browser-extension/booru-tags.test.js
// The upload popup's booru tag reader, fed the HTML-escaped text that
// Gelbooru-engine and Moebooru JSON hand out.

const context = { siteId: 'gelbooru', label: 'Gelbooru-style' }

const gelbooru = booru.parseGelbooruJson(
  { post: [{ tags: 'girls&#039;_frontline &gt;_&lt; tom_&amp;_jerry solo', rating: 'general' }] },
  context,
)
assert.deepEqual(gelbooru.tags, [">_<", "girls'_frontline", 'solo', 'tom_&_jerry'])
assert.equal(gelbooru.categories["girls'_frontline"], 'general')

const moebooru = booru.parseMoebooruJson(
  [{ tags: 'girls&#039;_frontline highres', rating: 's' }],
  { siteId: 'moebooru', label: 'Moebooru' },
)
assert.deepEqual(moebooru.tags, ["girls'_frontline", 'highres'])

// The tag-type lookup answers with the same escaping (XML attributes or
// JSON), and must still land on the decoded tag.
const typed = booru.applyGelbooruTagTypes(
  booru.parseGelbooruJson([{ tags: 'girls&#039;_frontline solo' }], context),
  booru.parseGelbooruTagTypeXml('<tags><tag type="3" name="girls&#039;_frontline"/><tag type="0" name="solo"/></tags>'),
)
assert.equal(typed.categories["girls'_frontline"], 'copyright')
assert.equal(typed.counts.copyright, 1)

console.log('booru-tags tests passed')
