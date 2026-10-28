import assert from 'node:assert/strict'
import test from 'node:test'
import { MetaAiClient } from './metaClient.ts'

const response = (content: object) =>
  new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 17, completion_tokens: 9 },
  }), { status: 200 })

test('Meta client sends authenticated structured requests and reports usage', async () => {
  let requestBody: Record<string, unknown> | undefined
  let authorization = ''
  let usage: unknown
  const client = new MetaAiClient({
    apiKey: 'test-key',
    baseUrl: 'https://meta.example/v1',
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return response({
        summary: 'One issue found.',
        score: 88,
        findings: [],
        categoryScores: { perceivable: 90, operable: 80, understandable: 90, robust: 90 },
      })
    },
    onUsage: (value) => { usage = value },
  })

  const report = await client.analyzeRepositorySource('https://github.com/acme/site', [])

  assert.equal(authorization, 'Bearer ' + 'test-key')
  assert.equal(requestBody?.model, 'muse-code')
  assert.deepEqual((requestBody?.response_format as { type: string }).type, 'json_schema')
  assert.equal(report.repoUrl, 'https://github.com/acme/site')
  assert.deepEqual(usage, { model: 'muse-code', inputTokens: 17, outputTokens: 9 })
})

test('Meta client retries transient errors and fails fast without configuration', async () => {
  let calls = 0
  const client = new MetaAiClient({
    apiKey: 'test-key',
    baseUrl: 'https://meta.example/v1',
    fetcher: async () => {
      calls += 1
      return calls === 1
        ? new Response('', { status: 503 })
        : response({ segments: [] })
    },
  })
  await client.analyzeWebDomAndVisuals('https://example.com', '<main />', 'image', {})
  assert.equal(calls, 3)

  const unconfigured = new MetaAiClient({ fetcher: fetch })
  await assert.rejects(
    unconfigured.analyzeRepositorySource('https://github.com/acme/site', []),
    /META_API_KEY and META_API_BASE_URL/,
  )
})
