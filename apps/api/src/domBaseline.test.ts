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
