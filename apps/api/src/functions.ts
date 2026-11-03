import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions'
import { Octokit } from '@octokit/rest'
import type { AuditFinding, RemediationPlan, RepoFile, SourceCodeAuditReport } from '../../../packages/shared/src/types.js'
import {
  RemediationPlanSchema,
  RepositoryScanRequestSchema,
  SourceCodeAuditReportSchema,
  WebScanRequestSchema,
} from '../../../packages/shared/src/schemas.js'
import { renderScoreBadgeSvg } from '../../../packages/shared/src/scoreBadge.js'
import { REPOSITORY_SCAN_LIMITS } from '../../../packages/shared/src/scanLimits.js'
import { MetaAiClient, MetaApiError } from '../../../packages/engine/src/metaClient.js'
import { collectDomBaseline } from './domBaseline.js'
import {
  isIssueRepositoryAllowed,
  resolvePublicAddress,
  validatePublicUrl,
  verifyBearerToken,
} from './security.js'
import {
  consumeRateLimit,
  deleteUserData,
  enablePreviewForUser,
  getScanScore,
  getStoredScan,
  getOrCreateUser,
  saveRemediation,
  saveScan,
  type RemediationRecord,
} from './store.js'
import { canActivatePreview, getPreviewInviteCode } from './previewAccess.js'

const json = (body: unknown, status = 200): HttpResponseInit => ({
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  jsonBody: body,
})

const bodyOf = async <T>(request: HttpRequest): Promise<T> => {
  try {
    return await request.json() as T
  } catch {
    throw new RequestError(400, 'Request body must be valid JSON.')
  }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const fail = (error: unknown, context: InvocationContext, stage = 'request'): HttpResponseInit => {
  if (error instanceof MetaApiError) {
    context.error('AccessiWeb model request failed.', { stage, code: error.code, upstreamStatus: error.upstreamStatus })
    const failures = {
      not_configured: [503, 'AI analysis is not configured. Contact the operator to check the model endpoint, model name, and credentials.'],
      unavailable: [503, 'The AI analysis service is temporarily unavailable. Please try again later.'],
      timeout: [504, 'The AI analysis service timed out. Please try again later.'],
      request_failed: [502, 'The AI analysis service rejected the scan. Contact the operator to check model access and endpoint compatibility.'],
      invalid_response: [502, 'The AI analysis service returned an invalid report. Please try again later.'],
    } as const
    const [status, message] = failures[error.code]
    return json({ error: message }, status)
  }
  if (error instanceof RequestError) {
    if (error.status >= 500) context.error('AccessiWeb request failed.', { stage, status: error.status })
    return json({ error: error.message }, error.status)
  }
  context.error('AccessiWeb request failed.', { stage })
  return json({ error: 'The request could not be completed.' }, 500)
}

const ensureString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError(400, `${field} is required.`)
  }
  return value.trim()
}

const escapeIssueText = (value: string): string =>
  value
    .replace(/https?:\/\//gi, (scheme) => `${scheme.slice(0, -2)}\u200b//`)
    .replace(/@/g, '@\u200b')
    .replace(/[\\`*_{}[\]()#+.!|>~-]/g, '\\$&')
    .replace(/&/g, '&amp;')
    .replace(/[<>]/g, (character) => character === '<' ? '&lt;' : '&gt;')
    .replace(/\r?\n/g, ' ')

const renderIssueBody = (
  scanId: string,
  repoUrl: string,
  report: ReturnType<typeof SourceCodeAuditReportSchema.parse>,
): string => [
  '## AccessiWeb accessibility audit',
  '',
  `Repository: ${escapeIssueText(repoUrl)}`,
  `Scan ID: \`${scanId}\``,
  '',
  '### Summary',
  '',
  escapeIssueText(report.summary),
  '',
  '### Findings',
  '',
  ...report.findings.map((finding) =>
    `- **${escapeIssueText(finding.wcagCriterion)} · ${escapeIssueText(finding.severity)}** — ${escapeIssueText(finding.title)}${finding.filePath ? ` · \`${escapeIssueText(finding.filePath)}\`` : ''}${finding.startLine ? `:${finding.startLine}` : ''}${finding.description ? ` — ${escapeIssueText(finding.description)}` : ''}`,
  ),
  '',
  'Review findings and verify proposed fixes manually before merging.',
].join('\n')

const canonicalJson = (value: unknown): string => JSON.stringify(
  value,
  (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item,
)

const hashApprovedPlan = (plan: unknown): string =>
  createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')

const createApprovalToken = (
  secret: string,
  userId: string,
  repoUrl: string,
  approvalHash: string,
  expiresAt: string,
): string => {
  const claims = Buffer.from(canonicalJson({ userId, repoUrl, approvalHash, expiresAt }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(claims, 'utf8').digest('base64url')
  return `${claims}.${signature}`
}

const isValidApprovalToken = (
  token: string,
  secret: string,
  userId: string,
  repoUrl: string,
  approvalHash: string,
): boolean => {
  try {
    const [claims, signature, extra] = token.split('.')
    if (!claims || !signature || extra !== undefined) return false
    const expected = createHmac('sha256', secret).update(claims, 'utf8').digest()
    const provided = Buffer.from(signature, 'base64url')
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return false
    const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as {
      userId?: unknown
      repoUrl?: unknown
      approvalHash?: unknown
      expiresAt?: unknown
    }
    const expiresAt = typeof parsed.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : Number.NaN
    return parsed.userId === userId &&
      parsed.repoUrl === repoUrl &&
      parsed.approvalHash === approvalHash &&
      Number.isFinite(expiresAt) &&
      expiresAt > Date.now() &&
      expiresAt <= Date.now() + 10 * 60 * 1000
  } catch {
    return false
  }
}

type ApprovedRemediationPlan = {
  audit: SourceCodeAuditReport
  plan: RemediationPlan
  baseSha: string
  baseBranch: string
}

const requestUser = async (request: HttpRequest) => {
  let claims: Awaited<ReturnType<typeof verifyBearerToken>>
  try {
    claims = await verifyBearerToken(request.headers.get('authorization'))
  } catch {
    throw new RequestError(401, 'A valid Entra ID B2C bearer token is required.')
  }
  return getOrCreateUser(claims)
}

const optionalScanOwner = async (request: HttpRequest): Promise<string | undefined> => {
  const authorization = request.headers.get('authorization')
  if (!authorization) return undefined
  return (await requestUser(request)).entraOid
}

const clientAddress = (request: HttpRequest): string => {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown'
  // Azure front ends append the client as "ip:port" or "[ipv6]:port"; drop the ephemeral port.
  return forwarded.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1] ??
    forwarded.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)?.[1] ??
    forwarded
}

const consumeScanQuota = async (request: HttpRequest, owner?: string): Promise<void> => {
  const limitKey = owner
    ? `user:${owner}`
    : `ip:${createHash('sha256').update(clientAddress(request)).digest('hex')}`
  if (!await consumeRateLimit(limitKey, owner ? 30 : 10)) {
    throw new RequestError(429, 'The scan limit for this account or address has been reached.')
  }
}

const requirePreview = async (request: HttpRequest) => {
  if (process.env.FEATURE_ENABLE_AUTO_PR_PREVIEW !== 'true') {
    throw new RequestError(403, 'Autonomous remediation preview is disabled.')
  }
  const user = await requestUser(request)
  if (user.featureFlags.autoRemediationPrPreview !== true) {
    throw new RequestError(403, 'Your account is not enabled for autonomous remediation preview.')
  }
  return user
}

const fetchHtml = async (initialUrl: string): Promise<string> => {
  let url = initialUrl
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let validated: URL
    let address: string
    try {
      validated = await validatePublicUrl(url)
      address = await resolvePublicAddress(validated.hostname.replace(/^\[|\]$/g, ''))
    } catch {
      throw new RequestError(400, 'The target must resolve only to public IP addresses.')
    }
    const request = validated.protocol === 'https:' ? httpsRequest : httpRequest
    const lookupPinned: LookupFunction = (_hostname, options, callback) => {
      const family = isIP(address)
      if (options.all) callback(null, [{ address, family }])
      else callback(null, address, family)
    }
    const response = await new Promise<{
      status: number
      location?: string
      contentType?: string
      body: string
    }>((resolve, reject) => {
      const outgoing = request(validated, {
        lookup: lookupPinned,
        family: isIP(address),
        headers: { 'User-Agent': 'AccessiWebEngine/0.1 accessibility-audit' },
        signal: AbortSignal.timeout(15_000),
      }, (incoming) => {
        incoming.on('error', reject)
        const status = incoming.statusCode ?? 0
        const location = incoming.headers.location
        const contentType = incoming.headers['content-type']
        if ([301, 302, 303, 307, 308].includes(status)) {
          incoming.resume()
          incoming.on('end', () => resolve({
            status,
            ...(typeof location === 'string' ? { location } : {}),
            body: '',
          }))
          return
        }
        if (!status || status < 200 || status >= 300) {
          incoming.resume()
          incoming.on('end', () => resolve({ status, body: '' }))
          return
        }
        if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('text/html')) {
          incoming.resume()
          incoming.on('end', () => resolve({
            status: 415,
            contentType: typeof contentType === 'string' ? contentType : undefined,
            body: '',
          }))
          return
        }
        let body = ''
        let size = 0
        incoming.setEncoding('utf8')
        incoming.on('data', (chunk: string) => {
          size += Buffer.byteLength(chunk)
          if (size > 1_000_000) {
            outgoing.destroy(new RequestError(413, 'The target page is too large to analyze.'))
            return
          }
          body += chunk
        })
        incoming.on('end', () => resolve({ status, contentType, body }))
      })
      outgoing.on('error', reject)
      outgoing.end()
    }).catch((error: unknown) => {
      if (error instanceof RequestError) throw error
      if (error instanceof Error && (
        error.name === 'AbortError' || error.name === 'TimeoutError' ||
        ('code' in error && error.code === 'ETIMEDOUT')
      )) {
        throw new RequestError(504, 'The target page took too long to respond. Try again later or choose another page.')
      }
      throw new RequestError(502, 'The target page connection failed. Check that the site is publicly reachable and has a valid HTTPS certificate.')
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirects === 3) throw new RequestError(400, 'The target URL has too many redirects.')
      url = new URL(response.location, validated).href
      continue
    }
    if (response.status === 413) throw new RequestError(413, 'The target page is too large to analyze.')
    if (response.status === 415) {
      throw new RequestError(415, 'The target URL must return an HTML page.')
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RequestError(502, 'The target page could not be fetched.')
    }
    return response.body
  }
  throw new RequestError(400, 'The target URL has too many redirects.')
}

const parseRepoUrl = (value: string): { owner: string; repo: string; url: string } => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RequestError(400, 'Provide a public GitHub repository URL.')
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/)
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  ) {
    throw new RequestError(400, 'Provide a public GitHub repository URL.')
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/i, ''), url: `https://github.com/${match[1]}/${match[2].replace(/\.git$/i, '')}` }
}

const sourceExtensions = /\.(?:html?|tsx?|jsx?|vue|svelte|css)$/i

const checkRepositorySize = (bytes: number): void => {
  if (bytes > REPOSITORY_SCAN_LIMITS.maxTotalBytes) {
    throw new RequestError(413, `Repository source exceeds the ${REPOSITORY_SCAN_LIMITS.maxTotalBytes / 1_000_000} MB (${REPOSITORY_SCAN_LIMITS.maxTotalBytes.toLocaleString('en-US')} bytes) limit per scan. Use a smaller public repository or analyze its deployed web page.`)
  }
}

const getRepoFiles = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  branch?: string,
): Promise<{ files: RepoFile[]; headSha: string; baseBranch: string; treeSha: string }> => {
  const { data: repository } = await octokit.repos.get({ owner, repo })
  if (repository.private) throw new RequestError(400, 'Only public repositories can be scanned.')
  const baseBranch = branch ?? repository.default_branch
  const { data: reference } = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` })
  const headSha = reference.object.sha
  const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: headSha })
  const tree = await octokit.git.getTree({ owner, repo, tree_sha: commit.tree.sha, recursive: '1' })
  if (tree.data.truncated) throw new RequestError(413, 'GitHub returned an incomplete file tree. Use a smaller public repository or analyze its deployed web page.')
  const blobs = tree.data.tree.filter((entry) => entry.type === 'blob' && entry.path && sourceExtensions.test(entry.path))
  if (blobs.length > REPOSITORY_SCAN_LIMITS.maxFiles) {
    throw new RequestError(413, `This repository has ${blobs.length} supported source files; the limit is ${REPOSITORY_SCAN_LIMITS.maxFiles} per scan. Use a smaller public repository or analyze its deployed web page.`)
  }
  checkRepositorySize(blobs.reduce((bytes, entry) => bytes + (entry.size ?? 0), 0))

  const files: RepoFile[] = []
  let totalBytes = 0
  for (const entry of blobs) {
    if (!entry.path || !entry.sha) throw new RequestError(502, 'GitHub returned an incomplete source file reference.')
    const { data } = await octokit.git.getBlob({ owner, repo, file_sha: entry.sha })
    if (data.encoding !== 'base64') {
      throw new RequestError(502, 'GitHub could not return a supported source file. A partial repository scan was not performed.')
    }
    const content = Buffer.from(data.content, 'base64').toString('utf8')
    totalBytes += Buffer.byteLength(content)
    checkRepositorySize(totalBytes)
    files.push({ path: entry.path, content })
  }
  return { files, headSha, baseBranch, treeSha: commit.tree.sha }
}

const meta = () => new MetaAiClient({
  onUsage: (usage) => console.info(JSON.stringify({ event: 'meta_api_usage', ...usage })),
})

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/health',
  handler: () => json({ status: 'ok' }),
})

app.http('scanScoreBadge', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/scans/{scanId}/badge.svg',
  handler: async (request, context) => {
    try {
      const scanId = request.params.scanId ?? ''
      if (!/^[\da-f-]{36}$/i.test(scanId)) return json({ error: 'Scan not found.' }, 404)
      const score = await getScanScore(scanId)
      if (score === undefined) return json({ error: 'Scan not found.' }, 404)
      return {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
        body: renderScoreBadgeSvg(score),
      }
    } catch (error) {
      return fail(error, context)
    }
  },
})

app.http('webScan', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/scans/web',
  handler: async (request, context) => {
    let stage = 'validate_web_scan'
    try {
      const parsed = WebScanRequestSchema.safeParse(await bodyOf<unknown>(request))
      if (!parsed.success) throw new RequestError(400, 'Request body does not match the web scan schema.')
      const body = parsed.data
      stage = 'web_scan_identity'
      const scanOwner = await optionalScanOwner(request)
      stage = 'web_scan_quota'
      await consumeScanQuota(request, scanOwner)
      const targetUrl = body.targetUrl
      const issueRepo = body.targetRepoUrl
        ? parseRepoUrl(body.targetRepoUrl)
        : undefined
      const screenshotBase64 = body.screenshotBase64 ?? ''
      const screenshotMimeType = body.screenshotMimeType ?? 'image/png'
      const viewport = body.viewport ?? 'desktop'
      if (
        screenshotBase64.length > 8_000_000 ||
        (screenshotBase64 && (!/^[A-Za-z0-9+/]+={0,2}$/.test(screenshotBase64) ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(screenshotMimeType)))
      ) {
        throw new RequestError(400, 'The screenshot must be a valid base64 image smaller than 6 MB.')
      }
      stage = 'fetch_page'
      const html = await fetchHtml(targetUrl)
      const screenshotDataUrl = screenshotBase64
        ? `data:${screenshotMimeType};base64,${screenshotBase64}`
        : ''
      stage = 'analyze_page'
      const report = await meta().analyzeWebDomAndVisuals(
        targetUrl,
        html,
        screenshotDataUrl,
        collectDomBaseline(html),
        viewport,
      )
      stage = 'save_web_scan'
      const scanId = await saveScan('WEB_URL', targetUrl, report, scanOwner)
      return json({ scanId, report, ...(issueRepo ? { issueRepoUrl: issueRepo.url } : {}) })
    } catch (error) {
      return fail(error, context, stage)
    }
  },
})

app.http('repositoryScan', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/scans/repo',
  handler: async (request, context) => {
    try {
      const parsed = RepositoryScanRequestSchema.safeParse(await bodyOf<unknown>(request))
      if (!parsed.success) throw new RequestError(400, 'Request body does not match the repository scan schema.')
      const body = parsed.data
      const scanOwner = await optionalScanOwner(request)
      await consumeScanQuota(request, scanOwner)
      const repo = parseRepoUrl(body.repoUrl)
      const branch = body.branch
      const { files } = await getRepoFiles(new Octokit({ auth: process.env.GITHUB_BOT_TOKEN }), repo.owner, repo.repo, branch)
      const report = await meta().analyzeRepositorySource(repo.url, files)
      const scanId = await saveScan('SOURCE_CODE', repo.url, report, scanOwner)
      return json({ scanId, report })
    } catch (error) {
      return fail(error, context)
    }
  },
})

app.http('createIssue', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/github/issues',
  handler: async (request, context) => {
    try {
      const body = await bodyOf<{ scanId?: unknown }>(request)
      const scanId = ensureString(body.scanId, 'scanId')
      const scan = await getStoredScan(scanId)
      if (!scan || scan.scanType !== 'SOURCE_CODE') {
        throw new RequestError(404, 'A saved repository scan was not found.')
      }
      const repo = parseRepoUrl(scan.target)
      if (!isIssueRepositoryAllowed(repo.owner, repo.repo)) {
        throw new RequestError(403, 'The bot is not enabled for this repository. Open a manual issue instead.')
      }
      const report = SourceCodeAuditReportSchema.safeParse(scan.report)
      if (!report.success) throw new RequestError(500, 'The saved repository report is unavailable.')
      const title = `Accessibility audit: ${report.data.findings.length} finding${report.data.findings.length === 1 ? '' : 's'}`
      const issueBody = renderIssueBody(scanId, repo.url, report.data)
      if (issueBody.length > 60_000) {
        throw new RequestError(413, 'The saved report exceeds the GitHub issue size limit.')
      }
      const token = process.env.GITHUB_BOT_TOKEN
      if (!token) throw new RequestError(503, 'GitHub issue creation is not configured.')
      const octokit = new Octokit({ auth: token })
      const { data: repository } = await octokit.repos.get({ owner: repo.owner, repo: repo.repo })
      if (repository.private) throw new RequestError(400, 'Issues can only be created on public repositories.')
      if (!await consumeRateLimit(`issue:${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`, 5)) {
        throw new RequestError(429, 'Issue creation is temporarily rate-limited for this repository.')
      }
      for (const label of ['accessibility', 'wcag-2.2', 'accessiweb-audit']) {
        try {
          await octokit.issues.createLabel({
            owner: repo.owner,
            repo: repo.repo,
            name: label,
            color: label === 'accessibility' ? '1d76db' : '0e8a16',
          })
        } catch (error) {
          if ((error as { status?: number }).status !== 422) throw error
        }
      }
      const { data } = await octokit.issues.create({
        owner: repo.owner,
        repo: repo.repo,
        title,
        body: issueBody,
        labels: ['accessibility', 'wcag-2.2', 'accessiweb-audit'],
      })
      return json({ issueUrl: data.html_url })
    } catch (error) {
      return fail(error, context)
    }
  },
})

app.http('audioPreview', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/scans/audio-preview',
  handler: async (request, context) => {
    try {
      const body = await bodyOf<{ auditSummary?: unknown }>(request)
      const scanOwner = await optionalScanOwner(request)
      await consumeScanQuota(request, scanOwner)
      const audio = await meta().generateAudioEmpathyPreview(ensureString(body.auditSummary, 'auditSummary'))
      return json(audio)
    } catch (error) {
      return fail(error, context)
    }
  },
})

app.http('generateImage', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/images/accessibility-placeholder',
  handler: async (request, context) => {
    try {
      const body = await bodyOf<{ prompt?: unknown }>(request)
      const prompt = ensureString(body.prompt, 'prompt')
      if (prompt.length > 1_000) throw new RequestError(400, 'Image prompt must be 1,000 characters or fewer.')
      const scanOwner = await optionalScanOwner(request)
      await consumeScanQuota(request, scanOwner)
      return json(await meta().generateAccessiblePlaceholderImage(prompt))
    } catch (error) {
      return fail(error, context)
    }
  },
})

app.http('currentUser', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/users/me',
  handler: async (request, context) => {
    try {
      const user = await requestUser(request)
      return json({
        displayName: user.displayName,
        email: user.email,
        featureFlags: user.featureFlags,
      })
    } catch (error) {
      return fail(error, context)
    }
  },
})

app.http('deleteUserData', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'v1/users/me/data',
  handler: async (request, context) => {
    try {
      const user = await requestUser(request)
      await deleteUserData(user)
      return { status: 204 }
    } catch (error) {
      return fail(error, context)
    }
  },
})

const previewAccessHandler = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
  try {
    const user = await requestUser(request)
    const body = await bodyOf<{ code?: unknown }>(request)
    if (
      process.env.FEATURE_ENABLE_AUTO_PR_PREVIEW !== 'true' ||
      !canActivatePreview(body.code, getPreviewInviteCode(), user.previewAccessApproved === true)
    ) {
      throw new RequestError(403, 'Preview access could not be enabled.')
    }
    const updated = await enablePreviewForUser(user)
    return json({ featureFlags: updated.featureFlags })
  } catch (error) {
    return fail(error, context)
  }
}

app.http('previewAccess', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/users/me/preview-access',
  handler: previewAccessHandler,
})

app.http('previewUnlockLegacy', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/preview/unlock',
  handler: previewAccessHandler,
})

app.http('remediatePullRequest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/remediate/pull-request',
  handler: async (request, context) => {
    let remediationState: RemediationRecord | undefined
    try {
      const user = await requirePreview(request)
      const body = await bodyOf<{
        repoUrl?: unknown
        baseBranch?: unknown
        targetRepoOwner?: unknown
        approvedPlan?: unknown
        approvedPatchHash?: unknown
        approvalToken?: unknown
        planId?: unknown
      }>(request)
      const stage = body.approvedPlan === undefined ? 'prepare' : 'publish'
      const repo = parseRepoUrl(ensureString(body.repoUrl, 'repoUrl'))
      if (!isIssueRepositoryAllowed(repo.owner, repo.repo)) {
        throw new RequestError(403, 'The bot is not enabled for this repository.')
      }
      if (!await consumeRateLimit(`remediation:${stage}:user:${user.entraOid}`, 5)) {
        throw new RequestError(429, 'The hourly remediation limit for this account has been reached.')
      }
      const token = process.env.GITHUB_BOT_TOKEN
      if (!token) throw new RequestError(503, 'GitHub remediation is not configured.')
      const octokit = new Octokit({ auth: token })
      const authenticated = await octokit.users.getAuthenticated()
      if (repo.owner.toLowerCase() === authenticated.data.login.toLowerCase()) {
        throw new RequestError(403, 'Remediation requires an upstream repository outside the GitHub bot account.')
      }
      if (
        typeof body.targetRepoOwner === 'string' &&
        body.targetRepoOwner.toLowerCase() !== authenticated.data.login.toLowerCase()
      ) {
        throw new RequestError(403, 'The requested fork owner must be the authenticated GitHub bot account.')
      }
      let audit: SourceCodeAuditReport
      let plan: RemediationPlan
      let patches: RemediationPlan['patches']
      let headSha: string
      let treeSha: string
      let baseBranch: string
      if (body.approvedPlan === undefined) {
        if (process.env.META_ALLOW_AUTONOMOUS_REMEDIATION !== 'true') {
          throw new RequestError(503, 'Autonomous remediation plan generation is disabled.')
        }
        const { files, headSha: sourceSha, baseBranch: sourceBranch } = await getRepoFiles(
          octokit,
          repo.owner,
          repo.repo,
          typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
        )
        audit = await meta().analyzeRepositorySource(repo.url, files)
        if (audit.findings.length === 0) throw new RequestError(400, 'No accessibility findings need remediation.')
        plan = await meta().generateAutonomousRemediationPlan(files, audit.findings as AuditFinding[])
        const originalPaths = new Set(files.map((file) => file.path))
        patches = plan.patches
        const coveredFindings = new Set(patches.flatMap((patch) => patch.findingIds))
        if (
          patches.length === 0 ||
          new Set(patches.map((patch) => patch.filePath)).size !== patches.length ||
          patches.some((patch) =>
            !originalPaths.has(patch.filePath) ||
            patch.filePath.startsWith('/') ||
            patch.filePath.includes('\\') ||
            patch.filePath.split('/').includes('..') ||
            patch.filePath === 'ACCESSIBILITY_REMEDIATION_REPORT.md' ||
            patch.content.length > 1_000_000
          ) ||
          audit.findings.some((finding) => !coveredFindings.has(finding.id)) ||
          patches.reduce((size, patch) => size + Buffer.byteLength(patch.content), 0) > 1_500_000 ||
          Buffer.byteLength(plan.reportMarkdown) > 1_000_000
        ) {
          throw new RequestError(502, 'The remediation plan contained an invalid or unsupported file path.')
        }
        const approvedPlan: ApprovedRemediationPlan = {
          audit,
          plan,
          baseSha: sourceSha,
          baseBranch: sourceBranch,
        }
        if (Buffer.byteLength(canonicalJson(approvedPlan)) > 4_000_000) {
          throw new RequestError(502, 'The remediation plan exceeds the review size limit.')
        }
        const approvalHash = hashApprovedPlan(approvedPlan)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
        return json({
          stage: 'review',
          planId: approvalHash,
          approvedPlan,
          approvedPatchHash: approvalHash,
          approvalToken: createApprovalToken(token, user.entraOid, repo.url, approvalHash, expiresAt),
          expiresAt,
        })
      }

      if (!body.approvedPlan || typeof body.approvedPlan !== 'object' || Array.isArray(body.approvedPlan)) {
        throw new RequestError(400, 'The approved remediation plan is invalid.')
      }
      if (Buffer.byteLength(canonicalJson(body.approvedPlan)) > 4_000_000) {
        throw new RequestError(413, 'The approved remediation plan exceeds the request size limit.')
      }
      const candidate = body.approvedPlan as Partial<ApprovedRemediationPlan>
      const parsedAudit = SourceCodeAuditReportSchema.safeParse(candidate.audit)
      const parsedPlan = RemediationPlanSchema.safeParse(candidate.plan)
      if (
        !parsedAudit.success ||
        !parsedPlan.success ||
        typeof candidate.baseSha !== 'string' ||
        !/^[a-f0-9]{40,64}$/i.test(candidate.baseSha) ||
        typeof candidate.baseBranch !== 'string' ||
        candidate.baseBranch.length === 0 ||
        candidate.baseBranch.length > 255
      ) {
        throw new RequestError(400, 'The approved remediation plan is invalid.')
      }
      audit = parsedAudit.data
      plan = parsedPlan.data
      const approvedPlan: ApprovedRemediationPlan = {
        audit,
        plan,
        baseSha: candidate.baseSha,
        baseBranch: candidate.baseBranch,
      }
      const approvalHash = hashApprovedPlan(approvedPlan)
      if (
        typeof body.approvedPatchHash !== 'string' ||
        body.approvedPatchHash !== approvalHash ||
        body.planId !== approvalHash ||
        typeof body.approvalToken !== 'string' ||
        !isValidApprovalToken(body.approvalToken, token, user.entraOid, repo.url, approvalHash)
      ) {
        throw new RequestError(412, 'Review and approve the exact remediation plan before publishing it.')
      }
      const current = await getRepoFiles(octokit, repo.owner, repo.repo, approvedPlan.baseBranch)
      if (current.headSha !== approvedPlan.baseSha) {
        throw new RequestError(412, 'The repository changed after this plan was prepared. Generate and review a new plan.')
      }
      headSha = current.headSha
      treeSha = current.treeSha
      baseBranch = current.baseBranch
      patches = plan.patches
      const originalPaths = new Set(current.files.map((file) => file.path))
      if (patches.some((patch) => !originalPaths.has(patch.filePath))) {
        throw new RequestError(412, 'The approved plan no longer matches the repository files.')
      }

      const timestamp = Date.now()
      const branch = `fix/accessiweb-wcag-remediation-${timestamp}`
      remediationState = {
        id: `remediation_${timestamp}`,
        entraOid: user.entraOid,
        userId: user.id,
        repoUrl: repo.url,
        status: 'ingest',
        createdAt: new Date(timestamp).toISOString(),
      }
      await saveRemediation(remediationState)

      const remediationReport = [
        '# Accessibility remediation report',
        '',
        `Repository: ${repo.url}`,
        `Baseline score: ${audit.score}/100`,
        `Estimated score after remediation: ${plan.estimatedScoreAfter === undefined ? 'Requires a follow-up audit' : `${plan.estimatedScoreAfter}/100 (not verified by a follow-up scan)`}`,
        '',
        '## Executive summary',
        '',
        audit.summary,
        '',
        '## Findings',
        '',
        '| WCAG criterion | Severity | File | Finding |',
        '| --- | --- | --- | --- |',
        ...audit.findings.map((finding) =>
          `| ${finding.wcagCriterion} | ${finding.severity} | ${finding.filePath ?? 'Web page'}${finding.startLine ? `:${finding.startLine}` : ''} | ${finding.title} |`,
        ),
        '',
        '## Remediation details',
        '',
        plan.reportMarkdown,
        '',
        '## Verification notes',
        '',
        ...plan.verificationNotes.map((note) => `- ${note}`),
        '',
        '## WCAG 2.2 AA/AAA checklist',
        '',
        ...[...new Set(audit.findings.map((finding) => finding.wcagCriterion))].map((criterion) =>
          `- [ ] ${criterion} — patch proposed; verify manually and re-scan.`,
        ),
        '- [ ] Perform manual keyboard, screen-reader, and visual verification before merging.',
      ].join('\n')
      remediationState.status = 'document'
      remediationState.branch = branch
      await saveRemediation(remediationState)

      const targetOwner = repo.owner
      remediationState.status = 'submit_pr'
      await saveRemediation(remediationState)
      const fork = await octokit.repos.createFork({ owner: targetOwner, repo: repo.repo })
      const commitOwner = fork.data.owner.login
      const commitRepo = fork.data.name
      let forkRepository: Awaited<ReturnType<typeof octokit.repos.get>>['data'] | undefined
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          forkRepository = (await octokit.repos.get({ owner: commitOwner, repo: commitRepo })).data
          break
        } catch (error) {
          if ((error as { status?: number }).status !== 404 || attempt === 4) throw error
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
        }
      }
      // Never fall back to upstream privileges, including when GitHub returns an existing fork.
      if (
        !forkRepository ||
        commitOwner.toLowerCase() !== authenticated.data.login.toLowerCase() ||
        forkRepository.owner.login.toLowerCase() !== authenticated.data.login.toLowerCase() ||
        forkRepository.private ||
        !forkRepository.fork ||
        forkRepository.parent?.full_name.toLowerCase() !== `${targetOwner}/${repo.repo}`.toLowerCase()
      ) {
        throw new RequestError(403, 'A public bot-owned fork of the requested repository is required.')
      }
      let lastError: unknown
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await octokit.git.createRef({
            owner: commitOwner,
            repo: commitRepo,
            ref: `refs/heads/${branch}`,
            sha: headSha,
          })
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
        }
      }
      if (lastError) throw lastError

      const entries = await Promise.all(patches.map(async (patch) => {
        const blob = await octokit.git.createBlob({
          owner: commitOwner,
          repo: commitRepo,
          content: patch.content,
          encoding: 'utf-8',
        })
        return { path: patch.filePath, mode: '100644' as const, type: 'blob' as const, sha: blob.data.sha }
      }))
      const reportBlob = await octokit.git.createBlob({
        owner: commitOwner,
        repo: commitRepo,
        content: remediationReport,
        encoding: 'utf-8',
      })
      entries.push({
        path: 'ACCESSIBILITY_REMEDIATION_REPORT.md',
        mode: '100644' as const,
        type: 'blob' as const,
        sha: reportBlob.data.sha,
      })
      const newTree = await octokit.git.createTree({
        owner: commitOwner,
        repo: commitRepo,
        base_tree: treeSha,
        tree: entries,
      })
      const commit = await octokit.git.createCommit({
        owner: commitOwner,
        repo: commitRepo,
        message: 'Fix accessibility findings with AccessiWeb Engine',
        tree: newTree.data.sha,
        parents: [headSha],
      })
      await octokit.git.updateRef({
        owner: commitOwner,
        repo: commitRepo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
      })
      remediationState.commitSha = commit.data.sha
      await saveRemediation(remediationState)
      const pullRequest = await octokit.pulls.create({
        owner: targetOwner,
        repo: repo.repo,
        head: `${commitOwner}:${branch}`,
        head_repo: commitRepo,
        base: baseBranch,
        title: 'Remediate accessibility findings with AccessiWeb Engine',
        body: `## Compliance scores\n\n| Before | Estimated after |\n| ---: | ---: |\n| ${audit.score}/100 | ${plan.estimatedScoreAfter ?? 'Follow-up audit required'}${plan.estimatedScoreAfter === undefined ? '' : '/100'} |\n\n## Changed files\n\n${patches.map((patch) => `- \`${patch.filePath}\` — ${patch.findingIds.length} finding(s) addressed`).join('\n')}\n\n${plan.reportMarkdown}\n\n## Verification\n\n${plan.verificationNotes.map((note) => `- ${note}`).join('\n')}\n\n- [ ] Review all changes and manually verify with keyboard and assistive technology before merging.`,
      })
      remediationState.pullRequestUrl = pullRequest.data.html_url
      remediationState.status = 'complete'
      await saveRemediation(remediationState)
      return json(remediationState, 201)
    } catch (error) {
      if (remediationState && remediationState.status !== 'complete') {
        try {
          remediationState.status = 'failed'
          remediationState.failureMessage = error instanceof RequestError
            ? error.message
            : 'Remediation failed; see service logs.'
          await saveRemediation(remediationState)
        } catch {
          context.error('Could not persist remediation failure state.')
        }
      }
      return fail(error, context)
    }
  },
})
