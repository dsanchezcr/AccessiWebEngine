import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions'
import { Octokit } from '@octokit/rest'
import type { AuditFinding, RepoFile } from '../../../packages/shared/src/types.js'
import { MetaAiClient } from '../../../packages/engine/src/metaClient.js'
import { collectDomBaseline } from './domBaseline.js'
import { isIssueRepositoryAllowed, resolvePublicAddress, validatePublicUrl, verifyBearerToken } from './security.js'
import { deleteUserData, enablePreviewForUser, getOrCreateUser, saveRemediation, saveScan } from './store.js'

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

const fail = (error: unknown, context: InvocationContext): HttpResponseInit => {
  if (error instanceof RequestError) return json({ error: error.message }, error.status)
  context.error('AccessiWeb request failed.')
  return json({ error: 'The request could not be completed.' }, 500)
}

const ensureString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError(400, `${field} is required.`)
  }
  return value.trim()
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
        headers: { 'User-Agent': 'AccessiWebEngine/0.1 accessibility-audit' },
        signal: AbortSignal.timeout(15_000),
      }, (incoming) => {
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
  if (tree.data.truncated) throw new RequestError(413, 'This repository is too large to scan in one request.')
  const blobs = tree.data.tree.filter((entry) => entry.type === 'blob' && entry.path && sourceExtensions.test(entry.path))
  if (blobs.length > 60) throw new RequestError(413, 'This repository has too many source files for a single scan.')

  const files: RepoFile[] = []
  let totalBytes = 0
  for (const entry of blobs) {
    const { data } = await octokit.repos.getContent({ owner, repo, path: entry.path!, ref: headSha })
    if (Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64' || !data.content) continue
    const content = Buffer.from(data.content, 'base64').toString('utf8')
    totalBytes += Buffer.byteLength(content)
    if (totalBytes > 1_500_000) throw new RequestError(413, 'Repository source files exceed the scan size limit.')
    files.push({ path: entry.path!, content })
  }
  return { files, headSha, baseBranch, treeSha: commit.tree.sha }
}

const meta = () => new MetaAiClient({
  onUsage: (usage) => console.info(JSON.stringify({ event: 'meta_api_usage', ...usage })),
})

app.http('webScan', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/scans/web',
  handler: async (request, context) => {
    try {
      const body = await bodyOf<{
        targetUrl?: unknown
        targetRepoUrl?: unknown
        screenshotBase64?: unknown
        screenshotMimeType?: unknown
        viewport?: unknown
      }>(request)
      const targetUrl = ensureString(body.targetUrl, 'targetUrl')
      const issueRepo = typeof body.targetRepoUrl === 'string' && body.targetRepoUrl.trim()
        ? parseRepoUrl(body.targetRepoUrl.trim())
        : undefined
      const screenshotBase64 = typeof body.screenshotBase64 === 'string' ? body.screenshotBase64 : ''
      const screenshotMimeType = typeof body.screenshotMimeType === 'string' ? body.screenshotMimeType : 'image/png'
      const viewport = body.viewport === undefined ? 'desktop' : body.viewport
      if (viewport !== 'desktop' && viewport !== 'mobile') {
        throw new RequestError(400, 'viewport must be desktop or mobile.')
      }
      if (
        screenshotBase64.length > 8_000_000 ||
        (screenshotBase64 && (!/^[A-Za-z0-9+/]+={0,2}$/.test(screenshotBase64) ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(screenshotMimeType)))
      ) {
        throw new RequestError(400, 'The screenshot must be a valid base64 image smaller than 6 MB.')
      }
      const html = await fetchHtml(targetUrl)
      const screenshotDataUrl = screenshotBase64
        ? `data:${screenshotMimeType};base64,${screenshotBase64}`
        : ''
      const report = await meta().analyzeWebDomAndVisuals(
        targetUrl,
        html,
        screenshotDataUrl,
        collectDomBaseline(html),
        viewport,
      )
      const scanId = await saveScan('WEB_URL', targetUrl, report, await optionalScanOwner(request))
      return json({ scanId, report, ...(issueRepo ? { issueRepoUrl: issueRepo.url } : {}) })
    } catch (error) {
      return fail(error, context)
    }
  },
})

app.http('repositoryScan', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/scans/repo',
  handler: async (request, context) => {
    try {
      const body = await bodyOf<{ repoUrl?: unknown; branch?: unknown }>(request)
      const repo = parseRepoUrl(ensureString(body.repoUrl, 'repoUrl'))
      const branch = typeof body.branch === 'string' ? body.branch : undefined
      const { files } = await getRepoFiles(new Octokit(), repo.owner, repo.repo, branch)
      const report = await meta().analyzeRepositorySource(repo.url, files)
      const scanId = await saveScan('SOURCE_CODE', repo.url, report, await optionalScanOwner(request))
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
      const body = await bodyOf<{ repoUrl?: unknown; title?: unknown; body?: unknown }>(request)
      const repo = parseRepoUrl(ensureString(body.repoUrl, 'repoUrl'))
      if (!isIssueRepositoryAllowed(repo.owner, repo.repo)) {
        throw new RequestError(403, 'The bot is not enabled for this repository. Open a manual issue instead.')
      }
      const title = ensureString(body.title, 'title')
      const issueBody = ensureString(body.body, 'body')
      if (title.length > 200 || issueBody.length > 60_000) {
        throw new RequestError(413, 'Issue title or report exceeds the GitHub size limit.')
      }
      const token = process.env.GITHUB_BOT_TOKEN
      if (!token) throw new RequestError(503, 'GitHub issue creation is not configured.')
      const octokit = new Octokit({ auth: token })
      const { data: repository } = await octokit.repos.get({ owner: repo.owner, repo: repo.repo })
      if (repository.private) throw new RequestError(400, 'Issues can only be created on public repositories.')
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

app.http('previewUnlock', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/preview/unlock',
  handler: async (request, context) => {
    try {
      const user = await requestUser(request)
      const body = await bodyOf<{ code?: unknown }>(request)
      const configuredCode = process.env.JUDGE_DEMO_CODE
      if (
        process.env.FEATURE_ENABLE_AUTO_PR_PREVIEW !== 'true' ||
        !configuredCode ||
        ensureString(body.code, 'code') !== configuredCode
      ) {
        throw new RequestError(403, 'Preview access could not be enabled.')
      }
      const updated = await enablePreviewForUser(user)
      return json({ featureFlags: updated.featureFlags })
    } catch (error) {
      return fail(error, context)
    }
  },
})

app.http('remediatePullRequest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/remediate/pull-request',
  handler: async (request, context) => {
    try {
      const user = await requirePreview(request)
      const body = await bodyOf<{ repoUrl?: unknown; baseBranch?: unknown; targetRepoOwner?: unknown }>(request)
      const repo = parseRepoUrl(ensureString(body.repoUrl, 'repoUrl'))
      const token = process.env.GITHUB_BOT_TOKEN
      if (!token) throw new RequestError(503, 'GitHub remediation is not configured.')
      const octokit = new Octokit({ auth: token })
      const { files, headSha, baseBranch, treeSha } = await getRepoFiles(
        octokit,
        repo.owner,
        repo.repo,
        typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
      )
      const audit = await meta().analyzeRepositorySource(repo.url, files)
      if (audit.findings.length === 0) throw new RequestError(400, 'No accessibility findings need remediation.')
      const plan = await meta().generateAutonomousRemediationPlan(files, audit.findings as AuditFinding[])
      const originalPaths = new Set(files.map((file) => file.path))
      const patches = plan.patches.filter((patch) =>
        originalPaths.has(patch.filePath) &&
        !patch.filePath.startsWith('/') &&
        !patch.filePath.split('/').includes('..') &&
        patch.filePath !== 'docs/ACCESSIBILITY_AUDIT_AND_REMEDIATION.md' &&
        patch.content.length <= 1_000_000,
      )
      const coveredFindings = new Set(patches.flatMap((patch) => patch.findingIds))
      if (
        patches.length === 0 ||
        patches.length !== plan.patches.length ||
        audit.findings.some((finding) => !coveredFindings.has(finding.id)) ||
        patches.reduce((size, patch) => size + Buffer.byteLength(patch.content), 0) > 1_500_000 ||
        Buffer.byteLength(plan.reportMarkdown) > 1_000_000
      ) {
        throw new RequestError(502, 'The remediation plan contained an invalid or unsupported file path.')
      }

      const timestamp = Date.now()
      const branch = `fix/accessiweb-wcag-remediation-${timestamp}`
      const targetOwner = repo.owner
      const authenticated = await octokit.users.getAuthenticated()
      if (
        typeof body.targetRepoOwner === 'string' &&
        body.targetRepoOwner.toLowerCase() !== authenticated.data.login.toLowerCase()
      ) {
        throw new RequestError(403, 'The requested fork owner must be the authenticated GitHub bot account.')
      }
      let commitOwner = targetOwner
      let canPush = targetOwner.toLowerCase() === authenticated.data.login.toLowerCase()
      if (!canPush) {
        try {
          const permission = await octokit.repos.getCollaboratorPermissionLevel({
            owner: targetOwner,
            repo: repo.repo,
            username: authenticated.data.login,
          })
          canPush = ['admin', 'maintain', 'write'].includes(permission.data.permission)
        } catch {
          canPush = false
        }
      }
      if (canPush) {
        await octokit.git.createRef({
          owner: commitOwner,
          repo: repo.repo,
          ref: `refs/heads/${branch}`,
          sha: headSha,
        })
      } else {
        const fork = await octokit.repos.createFork({ owner: targetOwner, repo: repo.repo })
        commitOwner = fork.data.owner.login
        let lastError: unknown
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await octokit.git.createRef({
              owner: commitOwner,
              repo: repo.repo,
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
      }

      const remediationReport = [
        '# Accessibility audit and remediation',
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
      const entries = await Promise.all(patches.map(async (patch) => {
        const blob = await octokit.git.createBlob({
          owner: commitOwner,
          repo: repo.repo,
          content: patch.content,
          encoding: 'utf-8',
        })
        return { path: patch.filePath, mode: '100644' as const, type: 'blob' as const, sha: blob.data.sha }
      }))
      const reportBlob = await octokit.git.createBlob({
        owner: commitOwner,
        repo: repo.repo,
        content: remediationReport,
        encoding: 'utf-8',
      })
      entries.push({
        path: 'docs/ACCESSIBILITY_AUDIT_AND_REMEDIATION.md',
        mode: '100644' as const,
        type: 'blob' as const,
        sha: reportBlob.data.sha,
      })
      const newTree = await octokit.git.createTree({
        owner: commitOwner,
        repo: repo.repo,
        base_tree: treeSha,
        tree: entries,
      })
      const commit = await octokit.git.createCommit({
        owner: commitOwner,
        repo: repo.repo,
        message: 'Fix accessibility findings with AccessiWeb Engine',
        tree: newTree.data.sha,
        parents: [headSha],
      })
      await octokit.git.updateRef({
        owner: commitOwner,
        repo: repo.repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
      })
      const pullRequest = await octokit.pulls.create({
        owner: targetOwner,
        repo: repo.repo,
        head: commitOwner === targetOwner ? branch : `${commitOwner}:${branch}`,
        base: baseBranch,
        title: 'Remediate accessibility findings with AccessiWeb Engine',
        body: `## Compliance scores\n\n| Before | Estimated after |\n| ---: | ---: |\n| ${audit.score}/100 | ${plan.estimatedScoreAfter ?? 'Follow-up audit required'}${plan.estimatedScoreAfter === undefined ? '' : '/100'} |\n\n## Changed files\n\n${patches.map((patch) => `- \`${patch.filePath}\` — ${patch.findingIds.length} finding(s) addressed`).join('\n')}\n\n${plan.reportMarkdown}\n\n## Verification\n\n${plan.verificationNotes.map((note) => `- ${note}`).join('\n')}\n\n- [ ] Review all changes and manually verify with keyboard and assistive technology before merging.`,
      })
      const record = {
        id: `remediation_${timestamp}`,
        entraOid: user.entraOid,
        repoUrl: repo.url,
        branch,
        commitSha: commit.data.sha,
        pullRequestUrl: pullRequest.data.html_url,
        status: 'complete' as const,
      }
      await saveRemediation(record)
      return json(record, 201)
    } catch (error) {
      return fail(error, context)
    }
  },
})
