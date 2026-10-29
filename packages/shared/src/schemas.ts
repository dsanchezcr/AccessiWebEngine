import { z } from 'zod'

const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'URL must use HTTP or HTTPS.')

const GitHubRepositoryUrlSchema = HttpUrlSchema.refine((value) => {
  const url = new URL(value)
  return url.hostname.toLowerCase() === 'github.com' &&
    url.pathname.split('/').filter(Boolean).length >= 2
}, 'URL must identify a GitHub repository.')

export const FindingSeveritySchema = z.enum(['critical', 'serious', 'moderate', 'minor'])

export const RepoFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

export const AuditFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  filePath: z.string().nullable().optional().transform((value) => value ?? undefined),
  selector: z.string().nullable().optional().transform((value) => value ?? undefined),
  startLine: z.number().int().positive().nullable().optional().transform((value) => value ?? undefined),
  endLine: z.number().int().positive().nullable().optional().transform((value) => value ?? undefined),
  wcagCriterion: z.string().min(1),
  severity: FindingSeveritySchema,
  codeSnippet: z.string().nullable().optional().transform((value) => value ?? undefined),
  suggestedFixCode: z.string().nullable().optional().transform((value) => value ?? undefined),
}).strict()

export const AccessibilityAuditReportSchema = z.object({
  summary: z.string(),
  score: z.number().int().min(0).max(100),
  findings: z.array(AuditFindingSchema),
  categoryScores: z.object({
    perceivable: z.number().int().min(0).max(100),
    operable: z.number().int().min(0).max(100),
    understandable: z.number().int().min(0).max(100),
    robust: z.number().int().min(0).max(100),
  }).strict(),
  visualSegments: z.array(z.object({
    label: z.string(),
    bounds: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().nonnegative(),
      height: z.number().nonnegative(),
    }).strict(),
    issue: z.string().nullable().optional().transform((value) => value ?? undefined),
  }).strict()).optional(),
}).strict()

export const SourceCodeAuditReportSchema = AccessibilityAuditReportSchema.extend({
  repoUrl: z.string().url(),
}).strict()

export const RemediationPatchSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
  diff: z.string(),
  findingIds: z.array(z.string().min(1)).min(1),
}).strict()

export const RemediationPlanSchema = z.object({
  estimatedScoreAfter: z.number().int().min(0).max(100).optional(),
  patches: z.array(RemediationPatchSchema),
  reportMarkdown: z.string(),
  fileExplanations: z.array(z.object({
    filePath: z.string(),
    explanation: z.string(),
    wcagCriteria: z.array(z.string()),
  }).strict()).optional(),
  verificationNotes: z.array(z.string()),
}).strict()

export const PreviewAccessRequestSchema = z.object({
  code: z.string().max(512).optional(),
}).strict()

export const WebScanRequestSchema = z.object({
  targetUrl: HttpUrlSchema,
  viewport: z.enum(['desktop', 'mobile']).optional(),
  targetRepoUrl: GitHubRepositoryUrlSchema.optional(),
  screenshotBase64: z.string().max(8_000_000).optional(),
  screenshotMimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
}).strict()

export const RepositoryScanRequestSchema = z.object({
  repoUrl: GitHubRepositoryUrlSchema,
  branch: z.string().min(1).max(255).optional(),
}).strict()
