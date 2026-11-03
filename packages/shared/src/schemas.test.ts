import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AccessibilityAuditReportSchema,
  RepositoryScanRequestSchema,
  WebScanRequestSchema,
} from './schemas.ts'

test('shared request schemas accept valid scan inputs and reject invalid fields', () => {
  assert.equal(WebScanRequestSchema.safeParse({ targetUrl: 'https://example.com' }).success, true)
  assert.equal(WebScanRequestSchema.safeParse({
    targetUrl: 'https://example.com',
    screenshotBase64: 'abcd',
    screenshotMimeType: 'image/png',
  }).success, true)
  assert.equal(WebScanRequestSchema.safeParse({ targetUrl: 'file:///etc/passwd' }).success, false)
  assert.equal(WebScanRequestSchema.safeParse({
    targetUrl: 'https://example.com',
    unexpected: true,
  }).success, false)
  assert.equal(RepositoryScanRequestSchema.safeParse({ repoUrl: 'https://github.com/owner/repo' }).success, true)
  assert.equal(RepositoryScanRequestSchema.safeParse({ repoUrl: 'https://example.com' }).success, false)
})

test('audit report schema bounds scores and validates finding severity', () => {
  const report = {
    summary: 'One issue.',
    score: 75,
    findings: [{
      id: 'a11y-1',
      title: 'Add a label',
      description: 'This input has no accessible name.',
      wcagCriterion: '3.3.2',
      severity: 'serious',
    }],
    categoryScores: { perceivable: 80, operable: 70, understandable: 75, robust: 90 },
  }
  assert.equal(AccessibilityAuditReportSchema.safeParse(report).success, true)
  assert.equal(AccessibilityAuditReportSchema.safeParse({ ...report, score: 101 }).success, false)
  assert.equal(AccessibilityAuditReportSchema.safeParse({
    ...report,
    findings: [{ ...report.findings[0], severity: 'urgent' }],
  }).success, false)
})
