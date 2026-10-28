import assert from 'node:assert/strict'
import test from 'node:test'
import { MetaAiClient, validateSourceSyntax } from './metaClient.ts'

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

test('remediation plans group findings, validate patched syntax, and document criteria', async () => {
  const calls: string[] = []
  const client = new MetaAiClient({
    apiKey: 'test-key',
    baseUrl: 'https://meta.example/v1',
    fetcher: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>
      }
      calls.push(request.messages[0].content)
      const result = calls.length === 1
        ? { fileGroups: [{ filePath: 'src/Button.tsx', findingIds: ['keyboard'], dependencies: [], rationale: 'Make the control keyboard accessible.' }] }
        : {
            estimatedScoreAfter: 94,
            patches: [{
              filePath: 'src/Button.tsx',
              content: 'export const Button = () => <button type="button">Save</button>;\n',
              diff: '--- a/src/Button.tsx\n+++ b/src/Button.tsx',
              findingIds: ['keyboard'],
            }],
            fileExplanations: [{
              filePath: 'src/Button.tsx',
              explanation: 'Replaced a click-only element with a native button.',
              wcagCriteria: ['2.1.1 Keyboard'],
            }],
            reportMarkdown: 'Patch details.',
            verificationNotes: ['TypeScript syntax parsed successfully.'],
          }
      return response(result)
    },
  })
  const plan = await client.generateAutonomousRemediationPlan(
    [{ path: 'src/Button.tsx', content: '<div onClick={save}>Save</div>' }],
    [{
      id: 'keyboard',
      title: 'Control is not keyboard accessible',
      description: 'Use a semantic button.',
      filePath: 'src/Button.tsx',
      startLine: 1,
      endLine: 1,
      wcagCriterion: '2.1.1 Keyboard',
      severity: 'serious',
    }],
  )

  assert.equal(calls.length, 2)
  assert.match(calls[0], /Step 1/)
  assert.match(calls[1], /Step 2/)
  assert.match(plan.reportMarkdown, /WCAG criteria addressed/)
  assert.match(plan.reportMarkdown, /src\/Button\.tsx/)
})

test('patched source files with syntax errors are rejected', async () => {
  assert.equal(validateSourceSyntax('src/ok.tsx', 'export const Button = () => <button />').length, 0)
  assert.ok(validateSourceSyntax('src/broken.tsx', 'export const Button = () => <button>').length > 0)
  assert.ok(validateSourceSyntax('src/broken.html', '<main><h1>Title</main>').length > 0)
  assert.ok(validateSourceSyntax('src/broken.css', '.card { color: red;').length > 0)
})

test('open-weights and image models use their configured model routes', async () => {
  const calls: Array<{ url: string; model: string }> = []
  const client = new MetaAiClient({
    apiKey: 'test-key',
    baseUrl: 'https://meta.example/v1',
    museSparkOpenUrl: 'https://partner.example/v1',
    museImageModel: 'muse-image-test',
    fetcher: async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string }
      calls.push({ url: String(input), model: request.model })
      if (request.model === 'muse-image-test') {
        return response({ imageBase64: 'aW1hZ2U=', mimeType: 'image/png', altText: 'A placeholder graphic.' })
      }
      return response({
        summary: 'Audit complete.',
        score: 100,
        findings: [],
        categoryScores: { perceivable: 100, operable: 100, understandable: 100, robust: 100 },
      })
    },
  })

  await client.analyzeRepositoryWithOpenWeights('https://github.com/acme/site', [])
  const image = await client.generateAccessiblePlaceholderImage('A high-contrast banner')
  assert.equal(calls[0].url, 'https://partner.example/v1/chat/completions')
  assert.equal(calls[1].model, 'muse-image-test')
  assert.equal(image.mimeType, 'image/png')
})
