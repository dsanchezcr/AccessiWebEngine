import { z } from 'zod'

export const FindingSeveritySchema = z.enum(['critical', 'serious', 'moderate', 'minor'])

export const RepoFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

export const AuditFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  filePath: z.string().nullable().optional(),
  selector: z.string().nullable().optional(),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
  wcagCriterion: z.string().min(1),
  severity: FindingSeveritySchema,
  codeSnippet: z.string().nullable().optional(),
  suggestedFixCode: z.string().nullable().optional(),
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
    issue: z.string().nullable().optional(),
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
  targetUrl: z.string().url(),
  viewport: z.enum(['desktop', 'mobile']).optional(),
  targetRepoUrl: z.string().url().optional(),
  screenshotBase64: z.string().max(8_000_000).optional(),
  screenshotMimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
})

export const RepositoryScanRequestSchema = z.object({
  repoUrl: z.string().url(),
  branch: z.string().min(1).max(255).optional(),
})
