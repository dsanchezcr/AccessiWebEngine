export type FindingSeverity = 'critical' | 'serious' | 'moderate' | 'minor'

export interface RepoFile {
  path: string
  content: string
}

export interface AuditFinding {
  id: string
  title: string
  description: string
  filePath?: string
  startLine?: number
  endLine?: number
  wcagCriterion: string
  severity: FindingSeverity
  codeSnippet?: string
  suggestedFixCode?: string
}

export interface AccessibilityAuditReport {
  summary: string
  score: number
  findings: AuditFinding[]
  categoryScores: Record<'perceivable' | 'operable' | 'understandable' | 'robust', number>
  visualSegments?: Array<{
    label: string
    bounds: { x: number; y: number; width: number; height: number }
    issue?: string
  }>
}

export interface SourceCodeAuditReport extends AccessibilityAuditReport {
  repoUrl: string
}

export interface RemediationPlan {
  patches: Array<{
    filePath: string
    content: string
    diff: string
    findingIds: string[]
  }>
  reportMarkdown: string
  verificationNotes: string[]
}
