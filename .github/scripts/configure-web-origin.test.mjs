import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./configure-web-origin.sh', import.meta.url))
const primaryOrigin = 'https://gray-mushroom-08ea62b0f.5.azurestaticapps.net'
const previewOrigin = 'https://gray-mushroom-08ea62b0f-1.eastus2.5.azurestaticapps.net'

function runConfiguration(t, { siteUrl = previewOrigin, mode = 'success' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'accessiweb-cors-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const callsPath = join(directory, 'calls.jsonl')
  const summaryPath = join(directory, 'summary')
  writeFileSync(callsPath, '')
  writeFileSync(summaryPath, '')
  writeFileSync(join(directory, 'az'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.CALLS_PATH, JSON.stringify(process.argv.slice(2)) + '\\n')
`, { mode: 0o755 })
  writeFileSync(join(directory, 'curl'), `#!/usr/bin/env node
const args = process.argv.slice(2)
const origin = args.find((arg) => arg.startsWith('Origin: ')).slice('Origin: '.length)
if (process.env.CORS_MODE === 'connection-error') process.exit(22)
console.log('HTTP/1.1 204 No Content\\r')
console.log('Access-Control-Allow-Origin: ' + (process.env.CORS_MODE === 'wrong-origin' ? 'https://unrelated.example' : origin) + '\\r')
console.log('Access-Control-Allow-Methods: ' + (process.env.CORS_MODE === 'missing-method' ? 'GET' : 'GET, POST') + '\\r')
console.log('Access-Control-Allow-Headers: ' + (process.env.CORS_MODE === 'missing-header' ? 'content-type' : 'Content-Type, Authorization') + '\\r')
`, { mode: 0o755 })
  writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      RESOURCE_GROUP: 'test-resource-group',
      FUNCTION_APP_NAME: 'test-function',
      PRIMARY_SITE_URL: primaryOrigin,
      SITE_URL: siteUrl,
      API_URL: 'https://test-function.azurewebsites.net',
      GITHUB_STEP_SUMMARY: summaryPath,
      CALLS_PATH: callsPath,
      CORS_MODE: mode,
    },
  })
  return {
    ...result,
    calls: readFileSync(callsPath, 'utf8'),
    summary: readFileSync(summaryPath, 'utf8'),
  }
}

for (const [environment, siteUrl] of [['preview', previewOrigin], ['production', primaryOrigin]]) {
  test(`${environment} deployment allows exact default/deployed origins and publishes the actual URL`, (t) => {
    const result = runConfiguration(t, { siteUrl })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.calls.trim()), [
      'functionapp', 'cors', 'add',
      '--resource-group', 'test-resource-group',
      '--name', 'test-function',
      '--allowed-origins', primaryOrigin, ...(siteUrl === primaryOrigin ? [] : [siteUrl]),
      '--only-show-errors', '--output', 'none',
    ])
    assert.ok(!result.calls.includes('*'))
    assert.ok(result.summary.includes(`Frontend: ${siteUrl}\n`))
    assert.ok(result.summary.includes('API health: https://test-function.azurewebsites.net/api/v1/health'))
  })
}

for (const mode of ['wrong-origin', 'missing-method', 'missing-header', 'connection-error']) {
  test(`deployment fails without publishing ready links when CORS has ${mode}`, (t) => {
    const result = runConfiguration(t, { mode })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /CORS preflight failed/)
    assert.equal(result.summary, '')
  })
}

test('deployment requires the actual SWA upload URL rather than falling back to the default host', (t) => {
  const result = runConfiguration(t, { siteUrl: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must return its actual URL/)
  assert.equal(result.calls, '')
  assert.equal(result.summary, '')
})
