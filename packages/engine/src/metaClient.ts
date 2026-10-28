import type {
  AccessibilityAuditReport,
  AuditFinding,
  RemediationPlan,
  RepoFile,
  SourceCodeAuditReport,
} from '../../shared/src/types.js'

type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
  additionalProperties: false
}

type MetaClientOptions = {
  apiKey?: string
  baseUrl?: string
  museCodeModel?: string
  samModel?: string
  museWonderModel?: string
  fetcher?: typeof fetch
  onUsage?: (usage: { model: string; inputTokens?: number; outputTokens?: number }) => void
}

const findingSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    filePath: { type: ['string', 'null'] },
    startLine: { type: ['integer', 'null'] },
    endLine: { type: ['integer', 'null'] },
    wcagCriterion: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'serious', 'moderate', 'minor'] },
    codeSnippet: { type: ['string', 'null'] },
    suggestedFixCode: { type: ['string', 'null'] },
  },
  required: [
    'id',
    'title',
    'description',
    'filePath',
    'startLine',
    'endLine',
    'wcagCriterion',
    'severity',
    'codeSnippet',
    'suggestedFixCode',
  ],
  additionalProperties: false,
}

const auditSchema: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    findings: { type: 'array', items: findingSchema },
    categoryScores: {
      type: 'object',
      properties: {
        perceivable: { type: 'integer', minimum: 0, maximum: 100 },
        operable: { type: 'integer', minimum: 0, maximum: 100 },
        understandable: { type: 'integer', minimum: 0, maximum: 100 },
        robust: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['perceivable', 'operable', 'understandable', 'robust'],
      additionalProperties: false,
    },
  },
  required: ['summary', 'score', 'findings', 'categoryScores'],
  additionalProperties: false,
}

const remediationSchema: JsonSchema = {
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
          diff: { type: 'string' },
          findingIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['filePath', 'content', 'diff', 'findingIds'],
        additionalProperties: false,
      },
    },
    reportMarkdown: { type: 'string' },
    verificationNotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['patches', 'reportMarkdown', 'verificationNotes'],
  additionalProperties: false,
}

const usageOf = (value: unknown) =>
  value && typeof value === 'object' && 'usage' in value
    ? (value as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    : undefined

export class MetaAiClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly museCodeModel: string
  private readonly samModel: string
  private readonly museWonderModel: string
  private readonly fetcher: typeof fetch
  private readonly onUsage?: MetaClientOptions['onUsage']

  constructor(options: MetaClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.META_API_KEY ?? ''
    this.baseUrl = (options.baseUrl ?? process.env.META_API_BASE_URL ?? '').replace(/\/+$/, '')
    this.museCodeModel = options.museCodeModel ?? process.env.META_MUSE_CODE_MODEL ?? 'muse-code'
    this.samModel = options.samModel ?? process.env.META_SAM_MODEL ?? 'sam-3.1'
    this.museWonderModel = options.museWonderModel ?? process.env.META_MUSE_WONDER_MODEL ?? 'muse-wonder'
    this.fetcher = options.fetcher ?? fetch
    this.onUsage = options.onUsage
  }

  async analyzeWebDomAndVisuals(
    url: string,
    domSnapshot: string,
    screenshotBase64: string,
    axeBaseline: object,
  ): Promise<AccessibilityAuditReport> {
    let visualSegments: AccessibilityAuditReport['visualSegments'] = []
    if (screenshotBase64) {
      visualSegments = await this.request<{ segments: NonNullable<AccessibilityAuditReport['visualSegments']> }>(
        this.samModel,
        'Segment the screenshot into interactive elements. Report element labels, pixel bounds, overlap and contrast concerns; compare each target with the WCAG 2.2 minimum 24x24 CSS pixels and AAA 44x44 CSS pixels. Return {"segments":[{"label":"...","bounds":{"x":0,"y":0,"width":0,"height":0},"issue":"..."}]}.',
        { screenshotBase64 },
        {
          type: 'object',
          properties: {
            segments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  bounds: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                      width: { type: 'number' },
                      height: { type: 'number' },
                    },
                    required: ['x', 'y', 'width', 'height'],
                    additionalProperties: false,
                  },
                  issue: { type: ['string', 'null'] },
                },
                required: ['label', 'bounds', 'issue'],
                additionalProperties: false,
              },
            },
          },
          required: ['segments'],
          additionalProperties: false,
        },
      ).then((result) => result.segments as AccessibilityAuditReport['visualSegments'])
    }

    const report = await this.request<AccessibilityAuditReport>(
      this.museCodeModel,
      'Audit this rendered page for WCAG 2.2 issues. Include semantics, keyboard access, labels, headings, names, and non-text content. Return only the required report JSON.',
      { url, domSnapshot, axeBaseline, visualSegments },
      auditSchema,
    )
    return { ...report, visualSegments }
  }

  async analyzeRepositorySource(repoUrl: string, fileTree: RepoFile[]): Promise<SourceCodeAuditReport> {
    const report = await this.request<AccessibilityAuditReport>(
      this.museCodeModel,
      'Statically audit these source files for WCAG 2.2 A/AA/AAA defects. Give exact one-based line ranges, file paths, concise code snippets, and safe suggested fixes. Return only report JSON.',
      { repoUrl, files: fileTree },
      auditSchema,
    )
    return { ...report, repoUrl }
  }

  async generateAutonomousRemediationPlan(
    repoFiles: RepoFile[],
    findings: AuditFinding[],
  ): Promise<RemediationPlan> {
    return this.request<RemediationPlan>(
      this.museCodeModel,
      'Plan and patch the listed accessibility findings. Preserve application behavior and layout. Return complete updated file contents, unified diffs, finding IDs covered, a detailed remediation report, and verification notes. Do not modify unlisted files.',
      { repoFiles, findings },
      remediationSchema,
    )
  }

  async generateAudioEmpathyPreview(auditSummary: string): Promise<{ audioBase64: string; mimeType: string }> {
    return this.request(
      this.museWonderModel,
      'Create a brief screen-reader audio comparison for the described accessibility issues. Return base64 encoded audio and its MIME type as JSON.',
      { auditSummary },
      {
        type: 'object',
        properties: {
          audioBase64: { type: 'string' },
          mimeType: { type: 'string' },
        },
        required: ['audioBase64', 'mimeType'],
        additionalProperties: false,
      },
    )
  }

  private async request<T>(
    model: string,
    prompt: string,
    input: unknown,
    schema: JsonSchema,
  ): Promise<T> {
    if (!this.apiKey || !this.baseUrl) {
      throw new Error('Meta API is not configured. Set META_API_KEY and META_API_BASE_URL.')
    }

    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: prompt },
              { role: 'user', content: JSON.stringify(input) },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'accessibility_response', strict: true, schema },
            },
          }),
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
          if (response.status !== 429 && response.status < 500) {
            throw new Error(`Meta API request failed with status ${response.status}.`)
          }
          throw new Error(`Meta API temporarily unavailable (${response.status}).`)
        }
        const payload: unknown = await response.json()
        const usage = usageOf(payload)
        this.onUsage?.({
          model,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
        })
        const content = (payload as {
          choices?: Array<{ message?: { content?: string } }>
        }).choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          throw new Error('Meta API returned an empty structured response.')
        }
        return JSON.parse(content) as T
      } catch (error) {
        lastError = error
        const retryable = error instanceof Error && (
          error.name === 'TimeoutError' ||
          error.name === 'AbortError' ||
          error.message.includes('temporarily unavailable') ||
          error.message.includes('fetch failed')
        )
        if (!retryable || attempt === 2) throw error
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
      }
    }
    throw lastError
  }
}
