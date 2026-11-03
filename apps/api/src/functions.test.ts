import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { beforeEach, mock, test } from 'node:test'

// npm test builds the API before running these compiled-module tests.
const compiled = (name: string) => new URL(`../dist/apps/api/src/${name}.js`, import.meta.url).href
const handlers = new Map<string, (request: any, context: any) => Promise<any>>()
let quotaAllowed = true
let authenticated = false
let privateRepository = false
let forkOwner = 'bot'
let forkPrivate = false
let forkParent: string | undefined = 'upstream/site'
let forkIsFork = true
let forkMetadataFailures = 0
let forkMetadataAttempts = 0
let modelCalls = 0
let upstreamReads = 0
let forkCalls = 0
let responseStatus = 200
let responseContentType = 'text/html'
const quotas: Array<{ key: string; limit: number }> = []
const writes: Array<{ method: string; params: any }> = []
const clientOptions: any[] = []
const user = {
  id: 'user_test', entraOid: 'test',
  featureFlags: { autoRemediationPrPreview: true },
}
const audit = {
  findings: [{ id: 'finding', wcagCriterion: '1.1.1', severity: 'high', title: 'Image alt', filePath: 'index.html' }],
  summary: 'An image needs alt text.', score: 90,
}
const gitWrite = (method: string) => async (params: any) => {
  writes.push({ method, params })
  return { data: { sha: `${method}-sha` } }
}
class FakeOctokit {
  constructor(options: unknown) { clientOptions.push(options) }
  users = { getAuthenticated: async () => ({ data: { login: 'bot' } }) }
  repos = {
    get: async ({ owner }: { owner: string }) => {
      if (owner === 'bot') {
        forkMetadataAttempts += 1
        if (forkMetadataAttempts <= forkMetadataFailures) {
          throw Object.assign(new Error('Fork is not ready'), { status: 404 })
        }
        return { data: {
          owner: { login: forkOwner }, private: forkPrivate, fork: forkIsFork,
          parent: forkParent ? { full_name: forkParent } : undefined,
        } }
      }
      upstreamReads += 1
      return { data: { private: privateRepository, default_branch: 'main' } }
    },
    getContent: async () => ({ data: {
      type: 'file', encoding: 'base64', content: Buffer.from('<img src="logo.png">').toString('base64'),
    } }),
    createFork: async () => {
      forkCalls += 1
      return { data: { owner: { login: 'bot' }, name: 'renamed-site' } }
    },
    getCollaboratorPermissionLevel: async () => {
      throw new Error('Remediation must not consult upstream write privileges.')
    },
  }
  git = {
    getRef: async () => ({ data: { object: { sha: 'head-sha' } } }),
    getCommit: async () => ({ data: { tree: { sha: 'tree-sha' } } }),
    getTree: async () => ({ data: { tree: [{ type: 'blob', path: 'index.html' }] } }),
    createRef: gitWrite('createRef'),
    createBlob: gitWrite('createBlob'),
    createTree: gitWrite('createTree'),
    createCommit: gitWrite('createCommit'),
    updateRef: gitWrite('updateRef'),
  }
  pulls = { create: async (params: any) => {
    writes.push({ method: 'pull', params })
    return { data: { html_url: 'https://github.com/upstream/site/pull/1' } }
  } }
}
class FakeMetaClient {
  generateAudioEmpathyPreview = async () => { modelCalls += 1; return { audioUrl: 'preview' } }
  generateAccessiblePlaceholderImage = async () => { modelCalls += 1; return { imageUrl: 'image' } }
  analyzeRepositorySource = async () => { modelCalls += 1; return audit }
  generateAutonomousRemediationPlan = async () => ({
    patches: [{ filePath: 'index.html', content: '<img src="logo.png" alt="Logo">', findingIds: ['finding'] }],
    reportMarkdown: 'Added alt text.', verificationNotes: ['Check with a screen reader.'],
  })
}
const requestPage = (_url: unknown, _options: unknown, callback: (incoming: any) => void) => {
  const outgoing = new EventEmitter() as EventEmitter & { end: () => void }
  outgoing.end = () => {
    const incoming = new EventEmitter() as any
    incoming.statusCode = responseStatus
    incoming.headers = { location: 'https://public.example/next', 'content-type': responseContentType }
    incoming.resume = () => {
      assert.equal(incoming.listenerCount('error'), 1, 'drained responses must already have an error listener')
    }
    incoming.setEncoding = () => undefined
    callback(incoming)
    queueMicrotask(() => incoming.emit('error', new Error('Response aborted')))
  }
  return outgoing
}
mock.module('@azure/functions', { namedExports: {
  app: { http: (name: string, options: any) => handlers.set(name, options.handler) },
} })
mock.module('@octokit/rest', { namedExports: { Octokit: FakeOctokit } })
mock.module('node:http', { namedExports: { request: requestPage } })
mock.module('node:https', { namedExports: { request: requestPage } })
mock.module(new URL('../../../packages/engine/src/metaClient.js', compiled('functions')).href, {
  namedExports: { MetaAiClient: FakeMetaClient },
})
mock.module(compiled('security'), { namedExports: {
  verifyBearerToken: async () => {
    if (!authenticated) throw new Error('Invalid token')
    return { sub: 'test' }
  },
  consumeIssueWriteQuota: () => true,
  isIssueRepositoryAllowed: () => false,
  resolvePublicAddress: async () => '93.184.216.34',
  validatePublicUrl: async (value: string) => new URL(value),
} })
mock.module(compiled('store'), { namedExports: {
  consumeRateLimit: async (key: string, limit: number) => {
    quotas.push({ key, limit })
    return quotaAllowed
  },
  getOrCreateUser: async () => user,
  saveScan: async () => 'scan-id',
  saveRemediation: async () => undefined,
  deleteUserData: async () => undefined,
  enablePreviewForUser: async () => user,
  getScanScore: async () => undefined,
} })
await import(compiled('functions'))

beforeEach(() => {
  quotaAllowed = true
  authenticated = false
  privateRepository = false
  forkOwner = 'bot'
  forkPrivate = false
  forkParent = 'upstream/site'
  forkIsFork = true
  forkMetadataFailures = 0
  forkMetadataAttempts = 0
  modelCalls = 0
  upstreamReads = 0
  forkCalls = 0
  responseStatus = 200
  responseContentType = 'text/html'
  quotas.length = 0
  writes.length = 0
  clientOptions.length = 0
  process.env.GITHUB_BOT_TOKEN = 'test-bot-token'
  process.env.FEATURE_ENABLE_AUTO_PR_PREVIEW = 'true'
})
const invoke = (name: string, body: unknown, signedIn = false) => handlers.get(name)!({
  headers: new Headers(signedIn ? { authorization: '******', 'x-forwarded-for': '203.0.113.1' } : {}),
  json: async () => body,
}, { error: () => undefined })

for (const [endpoint, body] of [
  ['audioPreview', { auditSummary: 'Summary' }],
  ['generateImage', { prompt: 'Accessible placeholder' }],
] as const) {
  test(`${endpoint} enforces anonymous and authenticated quotas before calling the model`, async () => {
    quotaAllowed = false
    assert.equal((await invoke(endpoint, body)).status, 429)
    assert.equal(quotas.at(-1)?.limit, 10)
    assert.match(quotas.at(-1)!.key, /^ip:/)
    assert.equal(modelCalls, 0)
    authenticated = true
    assert.equal((await invoke(endpoint, body, true)).status, 429)
    assert.deepEqual(quotas.at(-1), { key: 'user:test', limit: 30 })
    assert.equal(modelCalls, 0)
    quotaAllowed = true
    assert.equal((await invoke(endpoint, body, true)).status, 200)
    assert.equal(modelCalls, 1)
  })
  test(`${endpoint} rejects invalid bearer tokens without anonymous fallback`, async () => {
    assert.equal((await invoke(endpoint, body, true)).status, 401)
    assert.equal(quotas.length, 0)
    assert.equal(modelCalls, 0)
  })
}

test('repository scans authenticate reads with the bot token but still reject private repositories', async () => {
  privateRepository = true
  const result = await invoke('repositoryScan', { repoUrl: 'https://github.com/upstream/site' })
  assert.equal(result.status, 400)
  assert.deepEqual(clientOptions, [{ auth: 'test-bot-token' }])
  assert.equal(modelCalls, 0)
})

test('public repository scans use the configured bot token', async () => {
  const result = await invoke('repositoryScan', { repoUrl: 'https://github.com/upstream/site' })
  assert.equal(result.status, 200)
  assert.deepEqual(clientOptions, [{ auth: 'test-bot-token' }])
  assert.equal(modelCalls, 1)
})

test('remediation always writes a verified fork using its returned name, never upstream permissions', async () => {
  authenticated = true
  const result = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
  assert.equal(result.status, 201)
  assert.deepEqual(quotas, [{ key: 'remediation:user:test', limit: 5 }])
  assert.equal(forkCalls, 1)
  assert.deepEqual(writes.filter(({ method }) => method !== 'pull').map(({ params }) => [params.owner, params.repo]),
    Array.from({ length: 6 }, () => ['bot', 'renamed-site']))
  const pull = writes.find(({ method }) => method === 'pull')!.params
  assert.equal(pull.owner, 'upstream')
  assert.equal(pull.repo, 'site')
  assert.match(pull.head, /^bot:fix\/accessiweb-/)
  assert.equal(pull.head_repo, 'renamed-site')
})

test('bot-owned remediation targets fail closed before source or model access', async () => {
  authenticated = true
  const result = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/bot/site' }, true)
  assert.equal(result.status, 403)
  assert.equal(upstreamReads, 0)
  assert.equal(modelCalls, 0)
  assert.equal(forkCalls, 0)
  assert.equal(writes.length, 0)
})

for (const failures of [2, 5]) {
  test(`fork metadata readiness retries are bounded (${failures} initial 404 responses)`, async (t) => {
    authenticated = true
    forkMetadataFailures = failures
    const waits: number[] = []
    t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => {
      waits.push(delay)
      queueMicrotask(callback)
      return {} as NodeJS.Timeout
    })
    const result = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
    assert.equal(result.status, failures < 5 ? 201 : 500)
    assert.equal(forkMetadataAttempts, Math.min(failures + 1, 5))
    assert.deepEqual(waits, failures < 5 ? [500, 1000] : [500, 1000, 1500, 2000])
    assert.equal(writes.filter(({ method }) => method !== 'pull').length, failures < 5 ? 6 : 0)
    assert.ok(writes.filter(({ method }) => method !== 'pull')
      .every(({ params }) => params.owner === 'bot' && params.repo === 'renamed-site'))
  })
}

for (const scenario of ['unrelated', 'private', 'wrong-owner', 'missing-parent', 'not-a-fork']) {
  test(`a ${scenario} fork fails closed without any commit writes`, async () => {
    authenticated = true
    if (scenario === 'unrelated') forkParent = 'other/repository'
    if (scenario === 'private') forkPrivate = true
    if (scenario === 'wrong-owner') forkOwner = 'other'
    if (scenario === 'missing-parent') forkParent = undefined
    if (scenario === 'not-a-fork') forkIsFork = false
    const result = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
    assert.equal(result.status, 403)
    assert.equal(writes.length, 0)
  })
}

for (const [status, contentType] of [[301, 'text/html'], [503, 'text/html'], [200, 'application/json'], [200, 'text/html']] as const) {
  test(`HTTP response errors are handled for ${status} ${contentType}`, async () => {
    responseStatus = status
    responseContentType = contentType
    const result = await invoke('webScan', { targetUrl: 'https://public.example' })
    assert.equal(result.status, 500)
    assert.equal(modelCalls, 0)
  })
}
