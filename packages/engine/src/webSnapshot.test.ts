import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareWebSnapshot } from './webSnapshot.ts'
import { WEB_SCAN_LIMITS } from '../../shared/src/scanLimits.ts'

test('web input omits large scripts, comments and data URLs without repairing source defects', () => {
  const html = `<html lang="en"><head><script>${'x'.repeat(2_000_000)}</script>
    <style>.button { color: #ccc; }</style></head><body>
    <!-- <img src="not-real.png"> -->
    <main><label for="name">Name</label><input id="name" aria-required="true">
    <button onclick="save()" style="color:red">Save</button>
    <img src="data:image/png;base64,${'a'.repeat(1_000_000)}" alt="Useful name">
    <a href="/next">Next</a><div role="not-a-role"></div></main></body></html>`
  const snapshot = prepareWebSnapshot(html)
  assert.equal(snapshot.truncated, false)
  assert.ok(snapshot.html.length < 600)
  assert.doesNotMatch(snapshot.html, /xxxxx|aaaaa|not-real/)
  assert.match(snapshot.html, /<html lang="en">/)
  assert.match(snapshot.html, /<style>\.button \{ color: #ccc; \}<\/style>/)
  assert.match(snapshot.html, /<label for="name">Name<\/label><input id="name" aria-required="true">/)
  assert.match(snapshot.html, /<button onclick="save\(\)" style="color:red">Save<\/button>/)
  assert.match(snapshot.html, /<img src="data:\[omitted\]" alt="Useful name">/)
  assert.match(snapshot.html, /<a href="\/next">Next<\/a><div role="not-a-role"><\/div>/)
  assert.equal(prepareWebSnapshot('<div><button>Broken</div>').html, '<div><button>Broken</div>')
})

test('web snapshot removals follow HTML parsing rather than script-like text or quoted delimiters', () => {
  const html = '<main title="a > b"><textarea><script>keep me</script></textarea><script>omit me</script></main>'
  assert.equal(prepareWebSnapshot(html).html, '<main title="a > b"><textarea><script>keep me</script></textarea></main>')
  assert.equal(prepareWebSnapshot('<template><script>omit me</script><button>Keep me</button></template>').html,
    '<template><button>Keep me</button></template>')
  assert.equal(prepareWebSnapshot('<main>Keep me</main><script>not closed').html, '<main>Keep me</main>')
  assert.equal(prepareWebSnapshot('<svg><image xlink:href="data:image/png;base64,secret"></image></svg>').html,
    '<svg><image xlink:href="data:[omitted]"></image></svg>')
  assert.equal(prepareWebSnapshot('<b data-url="data:secret">text<p>more</b></p>').html,
    '<b data-url="data:[omitted]">text<p>more</b></p>')
})

for (const length of [WEB_SCAN_LIMITS.maxModelCharacters, WEB_SCAN_LIMITS.maxModelCharacters + 1]) {
  test(`web snapshot applies the exact ${length}-character boundary after reduction`, () => {
    const html = `<main>${'a'.repeat(length - 13)}</main>`
    const snapshot = prepareWebSnapshot(html)
    assert.equal(html.length, length)
    assert.equal(snapshot.html.length, WEB_SCAN_LIMITS.maxModelCharacters)
    assert.equal(snapshot.truncated, length > WEB_SCAN_LIMITS.maxModelCharacters)
  })
}

test('web snapshot handles deeply nested markup without a recursive tree walk', () => {
  const html = `${'<div>'.repeat(12_000)}<script>omit me</script>${'</div>'.repeat(12_000)}`
  const snapshot = prepareWebSnapshot(html)
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.html.length, WEB_SCAN_LIMITS.maxModelCharacters)
  assert.doesNotMatch(snapshot.html, /omit me/)
})
