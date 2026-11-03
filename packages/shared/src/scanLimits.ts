export const REPOSITORY_SCAN_LIMITS = {
  maxFiles: 60,
  maxTotalBytes: 1_500_000,
  maxFileCharacters: 20_000,
} as const

export const repositoryScanLimitsDescription =
  `Up to ${REPOSITORY_SCAN_LIMITS.maxFiles} HTML, HTM, JS, JSX, TS, TSX, Vue, Svelte, or CSS files ` +
  `and ${REPOSITORY_SCAN_LIMITS.maxTotalBytes / 1_000_000} MB ` +
  `(${REPOSITORY_SCAN_LIMITS.maxTotalBytes.toLocaleString('en-US')} bytes) of combined source per scan. ` +
  `Only the first ${REPOSITORY_SCAN_LIMITS.maxFileCharacters.toLocaleString('en-US')} characters of each file are sent for AI review. ` +
  'Larger repositories or incomplete GitHub file trees are rejected. Use a smaller public repository or analyze its deployed web page instead.'
