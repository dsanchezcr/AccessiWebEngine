import { useEffect, useState, type FormEvent } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import type { AccessibilityAuditReport, AuditFinding, SourceCodeAuditReport } from '../../../packages/shared/src/types'
import { apiScope, loginRequest } from './auth/msalConfig'
import './App.css'

type ScanMode = 'web' | 'repo' | 'preview'
type ScanResult = { scanId: string; report: AccessibilityAuditReport | SourceCodeAuditReport; issueRepoUrl?: string }
type Profile = { featureFlags: { autoRemediationPrPreview: boolean }; email?: string; displayName?: string }

const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '')
const apiUrl = (path: string) => `${apiBase}/v1/${path}`

const rules: Array<[string, string]> = [
  ['Visual & layout', 'Contrast (4.5:1 AA / 7:1 AAA), 24 × 24 CSS-pixel minimum targets, focus visibility, zoom and reflow.'],
  ['Semantics & structure', 'Landmarks, heading order, accessible names and roles, form labels, image alternatives and table headers.'],
  ['Keyboard & interaction', 'Keyboard operation, focus order, non-semantic click targets, modal focus and live announcements.'],
]

const pages: Record<string, { title: string; intro: string; sections: Array<[string, string]> }> = {
  '/what-we-scan': {
    title: 'What we scan',
    intro: 'AccessiWeb combines source-level checks with an AI-assisted review of rendered page structure to surface actionable WCAG 2.2 issues.',
    sections: rules,
  },
  '/how-it-works': {
    title: 'How it works',
    intro: 'Audits follow a transparent pipeline. Meta models assist with analysis and proposed changes; repository writes are gated and reviewed through a pull request.',
    sections: [
      ['1. Ingest', 'A public URL or public GitHub repository is validated and its relevant markup is processed in memory.'],
      ['2. Audit', 'Muse Code returns structured findings. Web screenshot segmentation is available when a screenshot is provided to the engine.'],
      ['3. Remediate & verify', 'For enabled preview accounts, Muse Code proposes complete file patches and verification notes.'],
      ['4. Submit', 'The GitHub integration creates a branch and pull request. A maintainer can inspect every change before merging.'],
    ],
  },
  '/privacy': {
    title: 'Privacy & security',
    intro: 'Public page content and source files are processed to produce an audit; the service persists structured results rather than raw page or source contents.',
    sections: [
      ['Data handling', 'Scan reports and line references are stored in Cosmos DB. Raw HTML and repository file contents are not saved by the scan service.'],
      ['Authentication', 'Preview APIs validate Entra ID B2C bearer tokens and require both a global feature switch and a per-user feature flag.'],
      ['Credentials', 'Meta, GitHub and Cosmos credentials are read from server-side environment configuration. Never put secrets in Vite environment variables.'],
      ['Retention', 'Configure Cosmos DB retention and access controls for your deployment. Account-data deletion endpoints should be enabled before production use.'],
    ],
  },
  '/about': {
    title: 'About AccessiWeb Engine',
    intro: 'AI-assisted development is increasing the amount of web software being shipped. AccessiWeb Engine aims to make accessibility a routine part of building and maintaining it.',
    sections: [
      ['Our mission', 'Help teams find accessibility issues early and turn findings into precise, reviewable fixes.'],
      ['Open source', 'Contributions should include focused tests, preserve user privacy, and keep suggested changes reviewable by maintainers.'],
      ['Meta Global AI Developer Hackathon', 'Built for the Indie Developer Track, exploring how Meta AI tools can assist accessible software development.'],
    ],
  },
}

async function getAccessToken(instance: ReturnType<typeof useMsal>['instance'], account: ReturnType<typeof useMsal>['accounts'][number]) {
  const result = await instance.acquireTokenSilent({ ...loginRequest, scopes: [apiScope], account })
  return result.accessToken
}

async function apiRequest<T>(path: string, token: string | undefined, options?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...options?.headers,
    },
  })
  const payload = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`)
  return payload
}

function Header() {
  const { instance, accounts } = useMsal()
  const authenticated = useIsAuthenticated()
  const account = accounts[0]
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="AccessiWeb Engine home">
        <span className="brand-mark" aria-hidden="true">A</span>
        <span>AccessiWeb <strong>Engine</strong></span>
      </a>
      <nav aria-label="Main navigation" className="main-nav">
        <a href="/what-we-scan">What we scan</a>
        <a href="/how-it-works">How it works</a>
        <a href="/privacy">Privacy</a>
        <a href="/about">About</a>
      </nav>
      {authenticated ? (
        <button className="button button-quiet" onClick={() => void instance.logoutRedirect({ account })}>
          Sign out
        </button>
      ) : (
        <a className="button button-quiet" href="#preview" onClick={() => window.dispatchEvent(new Event('accessiweb:preview'))}>
          Sign in
        </a>
      )}
    </header>
  )
}

function Report({ result, repositoryUrl }: { result: ScanResult; repositoryUrl: string }) {
  const [message, setMessage] = useState('')
  const [issueUrl, setIssueUrl] = useState('')
  const [audioUrl, setAudioUrl] = useState('')
  const [audioLoading, setAudioLoading] = useState(false)
  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl])
  const report = result.report
  const findings = report.findings ?? []
  const markdown = [
    '# AccessiWeb accessibility audit',
    '',
    `Score: ${report.score}/100`,
    '',
    report.summary,
    '',
    ...findings.map((finding) => `## ${finding.title}\n\n- WCAG: ${finding.wcagCriterion}\n- Severity: ${finding.severity}\n- File: ${finding.filePath ?? 'Web page'}${finding.startLine ? `:${finding.startLine}` : ''}\n\n${finding.description}\n\n${finding.suggestedFixCode ? `\`\`\`\n${finding.suggestedFixCode}\n\`\`\`` : ''}`),
  ].join('\n')

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setMessage('Report copied. Paste it into a GitHub issue.')
    } catch {
      setMessage('Could not access the clipboard. Select and copy the report from the browser.')
    }
  }

  const createIssue = async () => {
    try {
      const created = await apiRequest<{ issueUrl: string }>('github/issues', undefined, {
        method: 'POST',
        body: JSON.stringify({
          repoUrl: repositoryUrl,
          title: `Accessibility audit: ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
          body: markdown,
        }),
      })
      setIssueUrl(created.issueUrl)
      setMessage('GitHub issue created.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Issue creation failed.')
    }
  }

  const generateAudio = async () => {
    setAudioLoading(true)
    setMessage('')
    try {
      const preview = await apiRequest<{ audioBase64: string; mimeType: string }>(
        'scans/audio-preview',
        undefined,
        { method: 'POST', body: JSON.stringify({ auditSummary: report.summary }) },
      )
      const mimeType = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4'].includes(preview.mimeType)
        ? preview.mimeType
        : ''
      if (!mimeType || preview.audioBase64.length > 20_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(preview.audioBase64)) {
        throw new Error('The audio service returned an unsupported preview.')
      }
      const bytes = Uint8Array.from(atob(preview.audioBase64), (character) => character.charCodeAt(0))
      setAudioUrl(URL.createObjectURL(new Blob([bytes], { type: mimeType })))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Audio preview generation failed.')
    } finally {
      setAudioLoading(false)
    }
  }

  const share = () => {
    const text = `Accessibility audit score: ${report.score}/100 — ${findings.length} WCAG findings.`
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <section className="results" aria-labelledby="results-heading">
      <div className="results-heading">
        <div>
          <p className="eyebrow">Audit complete · {result.scanId}</p>
          <h2 id="results-heading">Your accessibility report</h2>
        </div>
        <div className="score" aria-label={`Accessibility score ${report.score} out of 100`}>
          <strong>{report.score}</strong><span>/100</span>
        </div>
      </div>
      <p className="report-summary">{report.summary}</p>
      <div className="category-grid" aria-label="WCAG principle scores">
        {Object.entries(report.categoryScores ?? {}).map(([category, score]) => (
          <div className="category-card" key={category}><span>{category}</span><strong>{score}</strong></div>
        ))}
      </div>
      {report.visualSegments?.length ? (
        <section aria-labelledby="visual-heading">
          <h3 id="visual-heading">Visual segmentation</h3>
          <ul className="segment-list">
            {report.visualSegments.map((segment, index) => (
              <li key={`${segment.label}-${index}`}>
                <strong>{segment.label}</strong> — {segment.bounds.width} × {segment.bounds.height}px
                {segment.issue ? ` · ${segment.issue}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="finding-list">
        <h3>{findings.length} finding{findings.length === 1 ? '' : 's'}</h3>
        {findings.length ? findings.map((finding: AuditFinding, index) => (
          <details className="finding" key={`${finding.id}-${index}`}>
            <summary><span className={`severity severity-${finding.severity}`}>{finding.severity}</span>{finding.title}</summary>
            <p>{finding.description}</p>
            <p className="finding-meta">{finding.wcagCriterion}{finding.filePath ? ` · ${finding.filePath}` : ''}{finding.startLine ? `:${finding.startLine}` : ''}</p>
            {finding.codeSnippet ? <pre><code>{finding.codeSnippet}</code></pre> : null}
            {finding.suggestedFixCode ? <pre><code>{finding.suggestedFixCode}</code></pre> : null}
          </details>
        )) : <p>No findings were returned for this audit.</p>}
      </div>
      <div className="report-actions">
        <button className="button button-secondary" onClick={() => void copyReport()}>Copy issue Markdown</button>
        {repositoryUrl ? <button className="button button-secondary" onClick={() => void createIssue()}>Open issue with bot</button> : null}
        <button className="button button-secondary" onClick={() => void generateAudio()} disabled={audioLoading}>
          {audioLoading ? 'Generating audio…' : 'Hear screen-reader preview'}
        </button>
        <button className="button button-quiet" onClick={share}>Share audit to X</button>
      </div>
      {audioUrl ? <audio className="audio-preview" controls aria-label="Screen-reader empathy preview" src={audioUrl} /> : null}
      {issueUrl ? <p><a href={issueUrl} target="_blank" rel="noreferrer">View the created GitHub issue</a></p> : null}
      <p className="status-message" role="status" aria-live="polite">{message}</p>
    </section>
  )
}

function Workspace() {
  const [mode, setMode] = useState<ScanMode>('web')
  const [targetUrl, setTargetUrl] = useState('')
  const [targetRepoUrl, setTargetRepoUrl] = useState('')
  const [screenshotBase64, setScreenshotBase64] = useState('')
  const [screenshotName, setScreenshotName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [result, setResult] = useState<ScanResult>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { instance, accounts } = useMsal()
  const authenticated = useIsAuthenticated()
  const [profile, setProfile] = useState<Profile>()
  const [judgeCode, setJudgeCode] = useState('')
  const [previewMessage, setPreviewMessage] = useState('')

  useEffect(() => {
    const openPreview = () => setMode('preview')
    window.addEventListener('accessiweb:preview', openPreview)
    return () => window.removeEventListener('accessiweb:preview', openPreview)
  }, [])

  useEffect(() => {
    if (!authenticated || !accounts[0]) {
      setProfile(undefined)
      return
    }
    let active = true
    void getAccessToken(instance, accounts[0])
      .then((token) => apiRequest<Profile>('users/me', token))
      .then((current) => { if (active) setProfile(current) })
      .catch((cause: unknown) => { if (active) setPreviewMessage(cause instanceof Error ? cause.message : 'Could not load preview access.') })
    return () => { active = false }
  }, [accounts, authenticated, instance])

  const login = async () => {
    try {
      await instance.loginRedirect(loginRequest)
    } catch {
      setPreviewMessage('Sign-in could not be started. Check the Entra ID B2C configuration.')
    }
  }

  const submitScan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    setResult(undefined)
    try {
      const endpoint = mode === 'web' ? 'scans/web' : 'scans/repo'
      const payload = mode === 'web'
        ? { targetUrl, targetRepoUrl: targetRepoUrl || undefined, screenshotBase64: screenshotBase64 || undefined }
        : { repoUrl }
      const response = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json() as ScanResult & { error?: string }
      if (!response.ok) throw new Error(body.error || 'The scan could not be completed.')
      setResult(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The scan could not be completed.')
    } finally {
      setLoading(false)
    }
  }

  const unlockPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      const token = await getAccessToken(instance, accounts[0])
      await apiRequest('preview/unlock', token, {
        method: 'POST',
        body: JSON.stringify({ code: judgeCode }),
      })
      const current = await apiRequest<Profile>('users/me', token)
      setProfile(current)
      setPreviewMessage('Preview access enabled for this account.')
      setJudgeCode('')
    } catch (cause) {
      setPreviewMessage(cause instanceof Error ? cause.message : 'Preview access could not be enabled.')
    }
  }

  const submitRemediation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      const token = await getAccessToken(instance, accounts[0])
      const response = await apiRequest<{ pullRequestUrl: string }>('remediate/pull-request', token, {
        method: 'POST',
        body: JSON.stringify({ repoUrl }),
      })
      setPreviewMessage(`Pull request created: ${response.pullRequestUrl}`)
    } catch (cause) {
      setPreviewMessage(cause instanceof Error ? cause.message : 'Remediation could not be started.')
    }
  }

  return (
    <main id="main-content" className="page-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">AI-assisted · Human-reviewed</p>
          <h1>Make accessibility part of every release.</h1>
          <p className="hero-copy">The web is being built faster than ever. AccessiWeb Engine helps teams find and fix accessibility issues with Meta AI and Muse Code.</p>
          <a className="button button-primary" href="#scanner">Start a free audit <span aria-hidden="true">→</span></a>
        </div>
        <div className="hero-card" aria-label="Accessibility audit at a glance">
          <div className="orbit" aria-hidden="true"><span>WCAG<br />2.2</span></div>
          <p>Access for everyone,<br /><strong>built in by default.</strong></p>
          <div className="hero-chip"><span aria-hidden="true">✓</span> Reviewable fixes</div>
        </div>
      </section>

      <section className="scanner-panel" id="scanner" aria-labelledby="scanner-heading">
        <div className="section-heading">
          <p className="eyebrow">Choose an experience</p>
          <h2 id="scanner-heading">Start with a public audit</h2>
          <p>Scan a live page or public repository. Private autonomous remediation is available by preview access.</p>
        </div>
        <div className="mode-switch" aria-label="Analysis experience">
          <button type="button" aria-pressed={mode === 'web'} onClick={() => { setMode('web'); setError(''); setResult(undefined) }}>Web URL analysis</button>
          <button type="button" aria-pressed={mode === 'repo'} onClick={() => { setMode('repo'); setError(''); setResult(undefined) }}>Repository analysis</button>
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => { setMode('preview'); setError(''); setResult(undefined) }}>Autonomous PR <span className="preview-pill">Preview</span></button>
        </div>

        {mode !== 'preview' ? (
          <form className="scan-form" onSubmit={(event) => void submitScan(event)}>
            <label htmlFor="scan-target">{mode === 'web' ? 'Web page URL' : 'Public GitHub repository URL'}</label>
            <div className="scan-input-row">
              <input
                id="scan-target"
                name="target"
                type="url"
                required
                placeholder={mode === 'web' ? 'https://example.com' : 'https://github.com/owner/repository'}
                value={mode === 'web' ? targetUrl : repoUrl}
                onChange={(event) => mode === 'web' ? setTargetUrl(event.target.value) : setRepoUrl(event.target.value)}
              />
              <button className="button button-primary" type="submit" disabled={loading}>
                {loading ? 'Analyzing…' : 'Analyze'}
              </button>
            </div>
            {mode === 'web' ? (
              <div className="optional-fields">
                <div className="optional-repo">
                  <label htmlFor="issue-repository">Optional GitHub repository for issue creation</label>
                  <input
                    id="issue-repository"
                    type="url"
                    value={targetRepoUrl}
                    onChange={(event) => setTargetRepoUrl(event.target.value)}
                    placeholder="https://github.com/owner/repository"
                  />
                </div>
                <div className="optional-repo">
                  <label htmlFor="page-screenshot">Optional screenshot for visual analysis</label>
                  <input
                    id="page-screenshot"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-describedby="screenshot-help"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (!file) {
                        setScreenshotBase64('')
                        setScreenshotName('')
                        return
                      }
                      if (file.size > 6_000_000) {
                        setError('Choose an image smaller than 6 MB.')
                        event.target.value = ''
                        return
                      }
                      const reader = new FileReader()
                      reader.onload = () => {
                        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
                        setScreenshotBase64(dataUrl.split(',')[1] || '')
                        setScreenshotName(file.name)
                      }
                      reader.readAsDataURL(file)
                    }}
                  />
                  <span id="screenshot-help" className="form-hint">{screenshotName ? `Selected: ${screenshotName}` : 'Image is sent for analysis only and is not stored.'}</span>
                </div>
              </div>
            ) : null}
            <p className="form-hint">Only public targets are accepted. Source files are processed ephemerally.</p>
            {error ? <p className="error-message" role="alert">{error}</p> : null}
            {loading ? <p role="status" aria-live="polite">Analyzing your target. This may take a little while.</p> : null}
          </form>
        ) : (
          <section className="preview-box" id="preview" aria-labelledby="preview-heading">
            <span className="preview-label">Private preview</span>
            <h3 id="preview-heading">Autonomous remediation, with your review</h3>
            <p>Audit a public repository, prepare accessibility patches, and open a pull request. All changes remain reviewable before merge.</p>
            <ol className="walkthrough">
              <li><span>01</span> Review findings</li><li><span>02</span> Generate a proposed patch</li><li><span>03</span> Open a pull request</li>
            </ol>
            {!authenticated ? (
              <button className="button button-primary" onClick={() => void login()}>Sign in with Entra ID B2C</button>
            ) : profile?.featureFlags.autoRemediationPrPreview ? (
              <form className="scan-form" onSubmit={(event) => void submitRemediation(event)}>
                <label htmlFor="remediation-repo">Public GitHub repository URL</label>
                <div className="scan-input-row">
                  <input id="remediation-repo" type="url" required value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/owner/repository" />
                  <button className="button button-primary" type="submit">Create remediation PR</button>
                </div>
              </form>
            ) : (
              <>
                <button className="button button-primary" onClick={() => void login()}>Sign in / Request preview access</button>
                <form className="unlock-form" onSubmit={(event) => void unlockPreview(event)}>
                  <label htmlFor="judge-code">Judge demo code</label>
                  <input id="judge-code" type="password" autoComplete="off" value={judgeCode} onChange={(event) => setJudgeCode(event.target.value)} />
                  <button className="button button-secondary" type="submit" disabled={!judgeCode}>Unlock demo</button>
                </form>
              </>
            )}
            {previewMessage ? <p className="status-message" role="status" aria-live="polite">{previewMessage}</p> : null}
          </section>
        )}
        {result ? <Report result={result} repositoryUrl={result.issueRepoUrl || (mode === 'repo' ? repoUrl : '')} /> : null}
      </section>

      <section className="rules-section" aria-labelledby="rules-heading">
        <div className="section-heading">
          <p className="eyebrow">WCAG 2.2</p><h2 id="rules-heading">A clearer path to accessible experiences</h2>
        </div>
        <div className="rule-grid">
          {rules.map(([title, description], index) => (
            <article className="rule-card" key={title}>
              <span className="rule-number">0{index + 1}</span><h3>{title}</h3><p>{description}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}

function InfoPage({ pathname }: { pathname: string }) {
  const page = pages[pathname]
  return (
    <main id="main-content" className="page-shell info-page">
      <p className="eyebrow">AccessiWeb Engine</p>
      <h1>{page.title}</h1>
      <p className="info-intro">{page.intro}</p>
      <div className="info-sections">
        {page.sections.map(([title, content]) => <section key={title}><h2>{title}</h2><p>{content}</p></section>)}
      </div>
      <a className="button button-primary" href="/">Return to scanner</a>
    </main>
  )
}

function App() {
  const pathname = window.location.pathname.replace(/\/$/, '') || '/'
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Header />
      {pages[pathname] ? <InfoPage pathname={pathname} /> : <Workspace />}
      <footer className="site-footer">
        <a className="brand" href="/"><span className="brand-mark" aria-hidden="true">A</span><span>AccessiWeb <strong>Engine</strong></span></a>
        <p>Accessibility makes the web work better for everyone.</p>
        <nav aria-label="Footer navigation"><a href="/privacy">Privacy</a><a href="/about">About</a></nav>
      </footer>
    </>
  )
}

export default App
