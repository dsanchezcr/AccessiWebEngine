import assert from 'node:assert/strict'
import test from 'node:test'
import { collectDomBaseline } from './domBaseline.ts'

test('static DOM baseline reports language, labels, images, headings, and click handlers', () => {
  const baseline = collectDomBaseline(`
    <html lang="en"><main><h1>Title</h1><h3>Skipped level</h3>
    <img src="logo.svg"><img src="decorative.svg" alt="">
    <label for="email">Email</label><input id="email"><button onclick="submit()">Send</button>
    </main></html>
  `)

  assert.deepEqual(baseline.checks, {
    pageLanguagePresent: true,
    imageCount: 2,
    imagesWithoutAlt: 1,
    formControlCount: 1,
    controlsWithAccessibleLabel: 1,
    headingLevels: [1, 3],
    headingOrderSkips: 1,
    landmarkCount: 1,
    nonEmptyAltCount: 0,
    inlineClickHandlerCount: 1,
  })
  assert.match(baseline.note, /does not execute page scripts/)
})

test('data attributes are not mistaken for accessibility attributes', () => {
  const baseline = collectDomBaseline(`
    <html data-lang="en"><mainland><img data-alt="logo">
    <label data-for="query">Search</label><input id="query" data-aria-label="query">
    </mainland></html>
  `)

  assert.equal(baseline.checks.pageLanguagePresent, false)
  assert.equal(baseline.checks.imagesWithoutAlt, 1)
  assert.equal(baseline.checks.controlsWithAccessibleLabel, 0)
  assert.equal(baseline.checks.landmarkCount, 0)
})

test('attribute-like text inside quoted values is not parsed as an attribute', () => {
  const baseline = collectDomBaseline(`
    <html title="lang='en'"><main><img title="alt='logo'">
    <input title="aria-label='Search'"></main></html>
  `)

  assert.equal(baseline.checks.pageLanguagePresent, false)
  assert.equal(baseline.checks.imagesWithoutAlt, 1)
  assert.equal(baseline.checks.controlsWithAccessibleLabel, 0)
})
