export const WEB_SCAN_LIMITS = {
  maxHtmlBytes: 5_000_000,
  pageRequestTimeoutMs: 15_000,
  maxRedirects: 3,
  maxModelCharacters: 100_000,
  analysisTimeoutMs: 120_000,
} as const

export const webScanLimitsDescription =
  `Public HTML documents up to ${WEB_SCAN_LIMITS.maxHtmlBytes / 1_000_000} MB ` +
  `(${WEB_SCAN_LIMITS.maxHtmlBytes.toLocaleString('en-US')} bytes) are accepted; this is not the total website download size. ` +
  'Linked images, scripts, and stylesheets are not downloaded. ' +
  `Each page request has a ${WEB_SCAN_LIMITS.pageRequestTimeoutMs / 1000}-second timeout, with at most ${WEB_SCAN_LIMITS.maxRedirects} redirects. ` +
  `AI analysis has a separate ${WEB_SCAN_LIMITS.analysisTimeoutMs / 1000}-second deadline. ` +
  `Scripts, comments, and embedded data URLs are omitted from AI input; only the first ${WEB_SCAN_LIMITS.maxModelCharacters.toLocaleString('en-US')} remaining HTML characters are reviewed. ` +
  'Reports identify partial AI reviews.'

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
