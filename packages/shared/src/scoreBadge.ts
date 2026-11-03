const badgeColor = (score: number) => score >= 90 ? '#16803c' : score >= 70 ? '#9a6700' : '#b42318'

export const renderScoreBadgeSvg = (score: number): string => {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new RangeError('Accessibility score must be an integer between 0 and 100.')
  }
  const scoreText = `${score}/100`
  const scoreWidth = Math.max(52, scoreText.length * 8 + 16)
  const totalWidth = 128 + scoreWidth
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-labelledby="title"><title id="title">AccessiWeb accessibility score: ${scoreText}</title><linearGradient id="background" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="round"><rect width="${totalWidth}" height="20" rx="3"/></clipPath><g clip-path="url(#round)"><rect width="128" height="20" fill="#333"/><rect x="128" width="${scoreWidth}" height="20" fill="${badgeColor(score)}"/><rect width="${totalWidth}" height="20" fill="url(#background)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="64" y="14">AccessiWeb score</text><text x="${128 + scoreWidth / 2}" y="14">${scoreText}</text></g></svg>`
}

export const createScoreBadgeMarkdown = (score: number, badgeUrl: string): string => {
  const parsedUrl = new URL(badgeUrl)
  if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
    throw new TypeError('Badge URL must use HTTP or HTTPS.')
  }
  return `![AccessiWeb accessibility score ${score}/100](${parsedUrl.toString()})`
}
