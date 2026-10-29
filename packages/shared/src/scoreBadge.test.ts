import assert from 'node:assert/strict'
import test from 'node:test'
import { createScoreBadgeMarkdown, renderScoreBadgeSvg } from './scoreBadge.ts'

test('score badge SVG validates and exposes its score to assistive technology', () => {
  const badge = renderScoreBadgeSvg(92)
  assert.match(badge, /AccessiWeb accessibility score: 92\/100/)
  assert.match(badge, /#16803c/)
  assert.throws(() => renderScoreBadgeSvg(101), RangeError)
})

test('score badge Markdown accepts only web URLs', () => {
  assert.equal(
    createScoreBadgeMarkdown(82, 'https://example.com/badge.svg'),
    '![AccessiWeb accessibility score 82/100](https://example.com/badge.svg)',
  )
  assert.throws(() => createScoreBadgeMarkdown(82, 'javascript:alert(1)'), TypeError)
})
