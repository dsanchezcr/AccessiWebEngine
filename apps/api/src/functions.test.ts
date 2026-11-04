import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { LookupFunction } from 'node:net'
import { beforeEach, mock, test } from 'node:test'
import { MetaApiError } from '../../../packages/engine/src/metaClient.ts'
import { WEB_SCAN_LIMITS } from '../../../packages/shared/src/scanLimits.ts'

// npm test builds the API before running these compiled-module tests.
const compiled = (name: string) => new URL(`../dist/apps/api/src/${name}.js`, import.meta.url).href
const handlers = new Map<string, (request: any, context: any) => Promise<any>>()
let quotaAllowed = true
let authenticated = false
let privateRepository = false
let issueRepositoryAllowed = true
let remediationRepositoryAllowed = true
let forkOwner = 'bot'
let forkPrivate = false
let forkParent: string | undefined = 'upstream/site'
let forkIsFork = true
let forkMetadataFailures = 0
let forkMetadataAttempts = 0
let sourceSha = 'a'.repeat(40)
let modelCalls = 0
let upstreamReads = 0
let forkCalls = 0
let responseStatus = 200
let responseContentType = 'text/html'
let responseBody = '<html lang="en"><main>Public page</main></html>'
let responseChunks: string[] | undefined
let responseError: Error | undefined
let outgoingError: Error | undefined
let redirectLocation = 'https://public.example/next'
let followRedirectWithSuccess = false
let modelFailure: Error | undefined
let quotaFailure: Error | undefined
let storageFailure: Error | undefined
let repositoryFileCount = 1
let repositoryContent = '<img src="logo.png">'
let repositoryFileSize: number | undefined
let repositoryTreeTruncated = false
let repositoryEncoding = 'base64'
let contentReads = 0
const requestedUrls: string[] = []
const validatedUrls: string[] = []
const savedScans: unknown[][] = []
const errorLogs: unknown[][] = []
const quotas: Array<{ key: string; limit: number }> = []
const writes: Array<{ method: string; params: any }> = []
const issueWrites: Array<{ method: string; params: any }> = []
const clientOptions: any[] = []
const user = {
  id: 'user_test', entraOid: 'test',
  featureFlags: { autoRemediationPrPreview: true },
}
const audit = {
  repoUrl: 'https://github.com/upstream/site',
  findings: [{
    id: 'finding', wcagCriterion: '1.1.1', severity: 'serious', title: 'Image alt',
    description: 'An image needs alt text.', filePath: 'index.html',
  }],
  summary: 'An image needs alt text.', score: 90,
  categoryScores: { perceivable: 90, operable: 90, understandable: 90, robust: 90 },
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
    createFork: async () => {
      forkCalls += 1
      return { data: { owner: { login: 'bot' }, name: 'renamed-site' } }
    },
    getCollaboratorPermissionLevel: async () => {
      throw new Error('Remediation must not consult upstream write privileges.')
    },
  }
  issues = {
    createLabel: async (params: any) => { issueWrites.push({ method: 'label', params }) },
    create: async (params: any) => {
      issueWrites.push({ method: 'issue', params })
      return { data: { html_url: 'https://github.com/upstream/site/issues/1' } }
    },
  }
  git = {
    getRef: async () => ({ data: { object: { sha: sourceSha } } }),
    getCommit: async () => ({ data: { tree: { sha: 'tree-sha' } } }),
    getTree: async () => ({ data: {
      truncated: repositoryTreeTruncated,
      tree: Array.from({ length: repositoryFileCount }, (_, index) => ({
        type: 'blob', path: index === 0 ? 'index.html' : `source-${index}.tsx`,
        size: repositoryFileSize, sha: `blob-${index}`,
      })),
    } }),
    getBlob: async ({ file_sha }: { file_sha: string }) => {
      assert.match(file_sha, /^blob-\d+$/)
      contentReads += 1
      return { data: {
        encoding: repositoryEncoding, content: Buffer.from(repositoryContent).toString('base64'),
      } }
    },
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
  analyzeWebDomAndVisuals = async () => {
    modelCalls += 1
    if (modelFailure) throw modelFailure
    const { repoUrl: _repoUrl, ...report } = audit
    return report
  }
  generateAutonomousRemediationPlan = async () => ({
    patches: [{
      filePath: 'index.html', content: '<img src="logo.png" alt="Logo">',
      diff: '--- a/index.html\n+++ b/index.html', findingIds: ['finding'],
    }],
    reportMarkdown: 'Added alt text.', verificationNotes: ['Check with a screen reader.'],
  })
}
const requestPage = (url: URL, options: { family: number; lookup: LookupFunction }, callback: (incoming: any) => void) => {
  requestedUrls.push(url.href)
  assert.equal(options.family, 4)
  options.lookup(url.hostname, {}, (error, address, family) => {
    assert.equal(error, null)
    assert.equal(address, '93.184.216.34')
    assert.equal(family, 4)
  })
  let destroyed = false
  const outgoing = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void }
  outgoing.destroy = (error) => {
    destroyed = true
    queueMicrotask(() => outgoing.emit('error', error))
  }
  outgoing.end = () => {
    if (outgoingError) {
      queueMicrotask(() => outgoing.emit('error', outgoingError))
      return
    }
    const incoming = new EventEmitter() as any
    incoming.statusCode = followRedirectWithSuccess && requestedUrls.length > 1 ? 200 : responseStatus
    incoming.headers = { location: redirectLocation, 'content-type': responseContentType }
    incoming.resume = () => {
      assert.equal(incoming.listenerCount('error'), 1, 'drained responses must already have an error listener')
    }
    incoming.setEncoding = () => undefined
    callback(incoming)
    queueMicrotask(() => {
      if (responseError) {
        incoming.emit('error', responseError)
        return
      }
      for (const chunk of responseChunks ?? [responseBody]) {
        incoming.emit('data', chunk)
        if (destroyed) break
      }
      if (!destroyed) incoming.emit('end')
    })
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
  namedExports: { MetaAiClient: FakeMetaClient, MetaApiError },
})
mock.module(compiled('security'), { namedExports: {
  verifyBearerToken: async () => {
    if (!authenticated) throw new Error('Invalid token')
    return { sub: 'test' }
  },
  isIssueRepositoryAllowed: (_owner: string, repo: string) =>
    repo === 'site' && issueRepositoryAllowed && remediationRepositoryAllowed,
  resolvePublicAddress: async () => '93.184.216.34',
  validatePublicUrl: async (value: string) => {
    validatedUrls.push(value)
    const url = new URL(value)
    if (url.hostname === 'private.example') throw new Error('Private address')
    return url
  },
} })
mock.module(compiled('store'), { namedExports: {
  consumeRateLimit: async (key: string, limit: number) => {
    if (quotaFailure) throw quotaFailure
    quotas.push({ key, limit })
    return quotaAllowed
  },
  getOrCreateUser: async () => user,
  saveScan: async (...args: unknown[]) => {
    if (storageFailure) throw storageFailure
    savedScans.push(args)
    return 'scan-id'
  },
  getStoredScan: async (id: string) => id === 'scan-id' ? {
    scanType: 'SOURCE_CODE',
    target: 'https://github.com/upstream/site',
    report: {
      ...audit,
      summary: '@everyone click https://phish.example',
      repoUrl: 'https://github.com/upstream/site',
      categoryScores: { perceivable: 90, operable: 90, understandable: 90, robust: 90 },
    },
  } : undefined,
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
  issueRepositoryAllowed = true
  remediationRepositoryAllowed = true
  forkOwner = 'bot'
  forkPrivate = false
  forkParent = 'upstream/site'
  forkIsFork = true
  forkMetadataFailures = 0
  forkMetadataAttempts = 0
  sourceSha = 'a'.repeat(40)
  modelCalls = 0
  upstreamReads = 0
  forkCalls = 0
  responseStatus = 200
  responseContentType = 'text/html'
  responseBody = '<html lang="en"><main>Public page</main></html>'
  responseChunks = undefined
  responseError = undefined
  outgoingError = undefined
  redirectLocation = 'https://public.example/next'
  followRedirectWithSuccess = false
  modelFailure = undefined
  quotaFailure = undefined
  storageFailure = undefined
  repositoryFileCount = 1
  repositoryContent = '<img src="logo.png">'
  repositoryFileSize = undefined
  repositoryTreeTruncated = false
  repositoryEncoding = 'base64'
  contentReads = 0
  requestedUrls.length = 0
  validatedUrls.length = 0
  savedScans.length = 0
  errorLogs.length = 0
  quotas.length = 0
  writes.length = 0
  issueWrites.length = 0
  clientOptions.length = 0
  process.env.GITHUB_BOT_TOKEN = 'test-bot-token'
  process.env.FEATURE_ENABLE_AUTO_PR_PREVIEW = 'true'
  process.env.META_ALLOW_AUTONOMOUS_REMEDIATION = 'true'
})
const invoke = (name: string, body: unknown, signedIn = false) => handlers.get(name)!({
  headers: new Headers(signedIn ? { authorization: '******', 'x-forwarded-for': '203.0.113.1' } : {}),
  json: async () => body,
}, { error: (...args: unknown[]) => errorLogs.push(args) })
const approveAndPublishRemediation = async (repoUrl: string) => {
  const prepared = await invoke('remediatePullRequest', { repoUrl }, true)
  const review = prepared.jsonBody as {
    approvedPlan: unknown
    planId: string
    approvedPatchHash: string
    approvalToken: string
  }
  return invoke('remediatePullRequest', {
    repoUrl,
    planId: review.planId,
    approvedPlan: review.approvedPlan,
    approvedPatchHash: review.approvedPatchHash,
    approvalToken: review.approvalToken,
  }, true)
}

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

for (const count of [60, 61]) {
  test(`repository scan enforces the exact 60-file limit for ${count} source files`, async () => {
    repositoryFileCount = count
    const result = await invoke('repositoryScan', { repoUrl: 'https://github.com/upstream/site' })
    assert.equal(result.status, count === 60 ? 200 : 413)
    assert.equal(modelCalls, count === 60 ? 1 : 0)
    assert.equal(contentReads, count === 60 ? 60 : 0)
    if (count > 60) assert.match(result.jsonBody.error, /61 supported source files; the limit is 60/)
  })
}

for (const bytes of [1_500_000, 1_500_001]) {
  test(`repository scan enforces the decoded UTF-8 size limit at ${bytes} bytes`, async () => {
    repositoryContent = '\u00e9'.repeat(750_000) + (bytes === 1_500_001 ? 'a' : '')
    const result = await invoke('repositoryScan', { repoUrl: 'https://github.com/upstream/site' })
    assert.equal(result.status, bytes === 1_500_000 ? 200 : 413)
    assert.equal(modelCalls, bytes === 1_500_000 ? 1 : 0)
    if (bytes > 1_500_000) assert.match(result.jsonBody.error, /1\.5 MB \(1,500,000 bytes\)/)
  })
}

test('repository tree metadata rejects oversized files before GitHub can omit their content', async () => {
  repositoryFileSize = 1_500_001
  repositoryEncoding = 'none'
  const result = await invoke('repositoryScan', { repoUrl: 'https://github.com/upstream/site' })
  assert.equal(result.status, 413)
  assert.equal(contentReads, 0)
  assert.equal(modelCalls, 0)
})

test('repository byte limits apply to combined source rather than each individual file', async () => {
  repositoryFileCount = 2
  repositoryContent = 'a'.repeat(750_001)
  const result = await invoke('repositoryScan', { repoUrl: 'https://github.com/upstream/site' })
  assert.equal(result.status, 413)
  assert.equal(contentReads, 2)
  assert.equal(modelCalls, 0)
})

test('truncated repository trees are rejected without reading source or calling the model', async () => {
  repositoryTreeTruncated = true
  const result = await invoke('repositoryScan', { repoUrl: 'https://github.com/upstream/site' })
  assert.equal(result.status, 413)
  assert.match(result.jsonBody.error, /incomplete file tree/)
  assert.equal(contentReads, 0)
  assert.equal(modelCalls, 0)
})

test('unavailable repository file content does not silently produce a partial audit', async () => {
  repositoryEncoding = 'none'
  const result = await invoke('repositoryScan', { repoUrl: 'https://github.com/upstream/site' })
  assert.equal(result.status, 502)
  assert.equal(modelCalls, 0)
  assert.equal(savedScans.length, 0)
})

test('GitHub issues are rendered from a stored scan and use the durable repository quota', async () => {
  const result = await invoke('createIssue', {
    scanId: 'scan-id',
    title: '@everyone click https://phish.example',
    body: 'untrusted caller text',
  })
  assert.equal(result.status, 200)
  assert.deepEqual(quotas, [{ key: 'issue:upstream/site', limit: 5 }])
  const created = issueWrites.find(({ method }) => method === 'issue')!.params
  assert.equal(created.title, 'Accessibility audit: 1 finding')
  assert.ok(created.body.includes('@\u200b'))
  assert.ok(created.body.includes('https:\u200b//'))
  assert.doesNotMatch(created.body, /@everyone|https:\/\/phish\.example|untrusted caller text/)
})

test('GitHub issue creation rejects a repository scan outside the allowlist', async () => {
  issueRepositoryAllowed = false
  const result = await invoke('createIssue', { scanId: 'scan-id' })
  assert.equal(result.status, 403)
  assert.equal(issueWrites.length, 0)
  assert.equal(quotas.length, 0)
})

test('GitHub issue creation applies a durable rate limit before writes', async () => {
  quotaAllowed = false
  const result = await invoke('createIssue', { scanId: 'scan-id' })
  assert.equal(result.status, 429)
  assert.equal(issueWrites.length, 0)
})

test('remediation always writes a verified fork using its returned name, never upstream permissions', async () => {
  authenticated = true
  const prepared = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
  assert.equal(prepared.status, 200)
  const review = prepared.jsonBody as {
    stage: string
    approvedPlan: unknown
    planId: string
    approvedPatchHash: string
    approvalToken: string
  }
  assert.equal(review.stage, 'review')
  assert.equal(review.planId, review.approvedPatchHash)
  assert.ok(review.approvedPatchHash)
  assert.ok(review.approvalToken)
  assert.equal(forkCalls, 0)
  assert.equal(writes.length, 0)
  const result = await invoke('remediatePullRequest', {
    repoUrl: 'https://github.com/upstream/site',
    planId: review.planId,
    approvedPlan: review.approvedPlan,
    approvedPatchHash: review.approvedPatchHash,
    approvalToken: review.approvalToken,
  }, true)
  assert.equal(result.status, 201)
  assert.deepEqual(quotas, [
    { key: 'remediation:prepare:user:test', limit: 5 },
    { key: 'remediation:publish:user:test', limit: 5 },
  ])
  assert.equal(forkCalls, 1)
  assert.deepEqual(writes.filter(({ method }) => method !== 'pull').map(({ params }) => [params.owner, params.repo]),
    Array.from({ length: 6 }, () => ['bot', 'renamed-site']))
  const pull = writes.find(({ method }) => method === 'pull')!.params
  assert.equal(pull.owner, 'upstream')
  assert.equal(pull.repo, 'site')
  assert.match(pull.head, /^bot:fix\/accessiweb-/)
  assert.equal(pull.head_repo, 'renamed-site')
})

for (const approval of [undefined, 'incorrect-hash']) {
  test(`remediation rejects ${approval === undefined ? 'missing' : 'mismatched'} patch approval before publishing content`, async () => {
    authenticated = true
    const prepared = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
    const review = prepared.jsonBody as {
      approvedPlan: unknown
      planId: string
      approvedPatchHash: string
      approvalToken: string
    }
    const result = await invoke('remediatePullRequest', {
      repoUrl: 'https://github.com/upstream/site',
      planId: review.planId,
      approvedPlan: review.approvedPlan,
      approvedPatchHash: approval,
      approvalToken: review.approvalToken,
    }, true)
    assert.equal(result.status, 412)
    assert.equal(forkCalls, 0)
    assert.equal(writes.length, 0)
  })
}

test('remediation rejects altered plans and unapproved repository targets before GitHub writes', async () => {
  authenticated = true
  const prepared = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
  const review = prepared.jsonBody as {
    approvedPlan: { plan: { patches: Array<{ content: string }> } }
    planId: string
    approvedPatchHash: string
    approvalToken: string
  }
  review.approvedPlan.plan.patches[0].content += '\n// altered'
  const altered = await invoke('remediatePullRequest', {
    repoUrl: 'https://github.com/upstream/site',
    planId: review.planId,
    approvedPlan: review.approvedPlan,
    approvedPatchHash: review.approvedPatchHash,
    approvalToken: review.approvalToken,
  }, true)
  assert.equal(altered.status, 412)
  assert.equal(forkCalls, 0)
  assert.equal(writes.length, 0)

  const clientsBeforeDeniedRequest = clientOptions.length
  remediationRepositoryAllowed = false
  const denied = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
  assert.equal(denied.status, 403)
  assert.equal(clientOptions.length, clientsBeforeDeniedRequest)
  assert.equal(forkCalls, 0)
  assert.equal(writes.length, 0)
})

test('remediation rejects a stale reviewed plan and disabled model opt-in without publishing', async () => {
  authenticated = true
  const prepared = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
  const review = prepared.jsonBody as {
    approvedPlan: unknown
    planId: string
    approvedPatchHash: string
    approvalToken: string
  }
  sourceSha = 'b'.repeat(40)
  const stale = await invoke('remediatePullRequest', {
    repoUrl: 'https://github.com/upstream/site',
    planId: review.planId,
    approvedPlan: review.approvedPlan,
    approvedPatchHash: review.approvedPatchHash,
    approvalToken: review.approvalToken,
  }, true)
  assert.equal(stale.status, 412)
  assert.equal(forkCalls, 0)
  assert.equal(writes.length, 0)

  process.env.META_ALLOW_AUTONOMOUS_REMEDIATION = 'false'
  const disabled = await invoke('remediatePullRequest', { repoUrl: 'https://github.com/upstream/site' }, true)
  assert.equal(disabled.status, 503)
  assert.equal(modelCalls, 1)
  assert.equal(forkCalls, 0)
  assert.equal(writes.length, 0)
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
    const result = await approveAndPublishRemediation('https://github.com/upstream/site')
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
    const result = await approveAndPublishRemediation('https://github.com/upstream/site')
    assert.equal(result.status, 403)
    assert.equal(writes.length, 0)
  })
}

for (const [status, contentType] of [[301, 'text/html'], [503, 'text/html'], [200, 'application/json'], [200, 'text/html']] as const) {
  test(`HTTP response errors are handled for ${status} ${contentType}`, async () => {
    responseStatus = status
    responseContentType = contentType
    responseError = new Error('Response aborted')
    const result = await invoke('webScan', { targetUrl: 'https://public.example' })
    assert.equal(result.status, 502)
    assert.match(result.jsonBody.error, /connection failed/)
    assert.equal(modelCalls, 0)
  })
}

test('web scan fetches, analyzes, and persists public HTML using a pinned address', async () => {
  const result = await invoke('webScan', { targetUrl: 'https://public.example' })
  assert.equal(result.status, 200)
  assert.equal(result.jsonBody.scanId, 'scan-id')
  assert.equal(modelCalls, 1)
  assert.deepEqual(requestedUrls, ['https://public.example/'])
  assert.equal(savedScans[0][0], 'WEB_URL')
})

test('each public redirect is revalidated and pinned before a successful web scan', async () => {
  responseStatus = 301
  followRedirectWithSuccess = true
  const result = await invoke('webScan', { targetUrl: 'https://public.example' })
  assert.equal(result.status, 200)
  assert.deepEqual(validatedUrls, ['https://public.example', 'https://public.example/next'])
  assert.deepEqual(requestedUrls, ['https://public.example/', 'https://public.example/next'])
})

test('redirects to private destinations are rejected before making a second request', async () => {
  responseStatus = 302
  redirectLocation = 'https://private.example/'
  const result = await invoke('webScan', { targetUrl: 'https://public.example' })
  assert.equal(result.status, 400)
  assert.equal(requestedUrls.length, 1)
  assert.equal(modelCalls, 0)
})

test('web scans reject more than three redirects', async () => {
  responseStatus = 302
  const result = await invoke('webScan', { targetUrl: 'https://public.example' })
  assert.equal(result.status, 400)
  assert.equal(requestedUrls.length, 4)
  assert.equal(modelCalls, 0)
})

for (const [error, status] of [
  [Object.assign(new Error('TLS failure with private details'), { code: 'CERT_HAS_EXPIRED' }), 502],
  [Object.assign(new Error('IPv6 unavailable'), { code: 'ENETUNREACH' }), 502],
  [Object.assign(new Error('aborted'), { name: 'AbortError' }), 504],
  [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 504],
] as const) {
  test(`web scan maps ${'code' in error ? error.code : error.name} to an actionable ${status} response`, async () => {
    outgoingError = error
    const result = await invoke('webScan', { targetUrl: 'https://public.example' })
    assert.equal(result.status, status)
    assert.doesNotMatch(JSON.stringify([result, errorLogs]), /private details|IPv6 unavailable/)
    assert.deepEqual(errorLogs[0][1], { stage: 'fetch_page', status })
    assert.equal(modelCalls, 0)
    assert.equal(savedScans.length, 0)
  })
}

for (const bytes of [1_000_001, 5_000_000, 5_000_001]) {
  test(`web scan enforces the exact UTF-8 page size limit at ${bytes} bytes`, async () => {
    responseBody = '\u00e9'.repeat(Math.floor(bytes / 2)) + (bytes % 2 ? 'a' : '')
    const result = await invoke('webScan', { targetUrl: 'https://public.example' })
    const accepted = bytes <= WEB_SCAN_LIMITS.maxHtmlBytes
    assert.equal(result.status, accepted ? 200 : 413)
    assert.equal(modelCalls, accepted ? 1 : 0)
    assert.equal(savedScans.length, accepted ? 1 : 0)
    if (!accepted) assert.match(result.jsonBody.error, /5 MB \(5,000,000 bytes\)/)
  })
}

test('web scan counts bytes across streamed chunks and rejects the first byte above 5 MB', async () => {
  responseChunks = ['a'.repeat(3_000_000), '\u00e9'.repeat(1_000_000), 'x']
  const result = await invoke('webScan', { targetUrl: 'https://public.example' })
  assert.equal(result.status, 413)
  assert.equal(modelCalls, 0)
  assert.equal(savedScans.length, 0)
})

test('web scan retains the 15-second timeout on every redirect request', async (t) => {
  const timeouts: number[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    timeouts.push(milliseconds)
    return new AbortController().signal
  })
  responseStatus = 301
  followRedirectWithSuccess = true
  assert.equal((await invoke('webScan', { targetUrl: 'https://public.example' })).status, 200)
  assert.deepEqual(timeouts, [15_000, 15_000])
})

for (const [code, status] of [
  ['not_configured', 503], ['unavailable', 503], ['timeout', 504],
  ['request_failed', 502], ['invalid_response', 502],
] as const) {
  test(`web scan reports model ${code} without exposing upstream content`, async () => {
    modelFailure = new MetaApiError(code, 'Sensitive upstream response', 400)
    const result = await invoke('webScan', { targetUrl: 'https://public.example' })
    assert.equal(result.status, status)
    assert.match(result.jsonBody.error, /AI analysis/)
    assert.doesNotMatch(JSON.stringify([result, errorLogs]), /Sensitive upstream response/)
    assert.deepEqual(errorLogs[0][1], { stage: 'analyze_page', code, upstreamStatus: 400 })
    assert.equal(savedScans.length, 0)
  })
}

for (const stage of ['web_scan_quota', 'save_web_scan']) {
  test(`unexpected ${stage} failures log the stage without raw content`, async () => {
    const error = new Error('Sensitive Cosmos details')
    if (stage === 'web_scan_quota') quotaFailure = error
    else storageFailure = error
    const result = await invoke('webScan', { targetUrl: 'https://public.example' })
    assert.equal(result.status, 500)
    assert.deepEqual(errorLogs[0][1], { stage })
    assert.doesNotMatch(JSON.stringify([result, errorLogs]), /Sensitive Cosmos details|public\.example/)
  })
}
