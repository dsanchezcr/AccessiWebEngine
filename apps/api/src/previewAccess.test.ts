import assert from 'node:assert/strict'
import test from 'node:test'
import { canActivatePreview, getPreviewInviteCode, isValidPreviewInvite } from './previewAccess.ts'

test('preview invite defaults only outside production', () => {
  assert.equal(getPreviewInviteCode('development', ''), 'META-HACKATHON-2026')
  assert.equal(getPreviewInviteCode('demo', ''), 'META-HACKATHON-2026')
  assert.equal(getPreviewInviteCode('production', ''), undefined)
  assert.equal(getPreviewInviteCode('prod', 'custom-secret'), 'custom-secret')
})

test('preview access accepts a matching invite or an admin approval', () => {
  assert.equal(isValidPreviewInvite('judge-code', 'judge-code'), true)
  assert.equal(isValidPreviewInvite('wrong-code', 'judge-code'), false)
  assert.equal(isValidPreviewInvite(undefined, 'judge-code'), false)
  assert.equal(canActivatePreview(undefined, undefined, true), true)
  assert.equal(canActivatePreview('wrong-code', 'judge-code', false), false)
})
