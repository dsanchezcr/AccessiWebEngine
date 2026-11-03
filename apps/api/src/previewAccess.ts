import { timingSafeEqual } from 'node:crypto'

const demoInviteCode = 'META-HACKATHON-2026'

export const getPreviewInviteCode = (
  environment = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
  configuredCode = process.env.META_PREVIEW_INVITE_CODE,
): string | undefined => {
  if (configuredCode?.trim()) return configuredCode.trim()
  return ['development', 'demo'].includes(environment.toLowerCase()) ? demoInviteCode : undefined
}

export const isValidPreviewInvite = (providedCode: unknown, configuredCode: string | undefined): boolean => {
  if (typeof providedCode !== 'string' || !configuredCode) return false
  const provided = Buffer.from(providedCode)
  const expected = Buffer.from(configuredCode)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

export const canActivatePreview = (
  providedCode: unknown,
  configuredCode: string | undefined,
  adminApproved: boolean,
): boolean => adminApproved || isValidPreviewInvite(providedCode, configuredCode)
