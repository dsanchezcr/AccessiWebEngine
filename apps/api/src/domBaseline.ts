export const collectDomBaseline = (html: string) => {
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map(([image]) => image)
  const controls = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)].map(([control]) => control)
  const headings = [...html.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]))
  const labelledIds = new Set(
    [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]),
  )
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? ''
  return {
    checks: {
      pageLanguagePresent: /\blang\s*=/i.test(htmlTag),
      imageCount: images.length,
      imagesWithoutAlt: images.filter((image) => !/\balt\s*=/i.test(image)).length,
      formControlCount: controls.length,
      controlsWithAccessibleLabel: controls.filter((control) =>
        /\b(?:aria-label|aria-labelledby)\s*=/i.test(control) ||
        labelledIds.has(control.match(/\bid\s*=\s*["']([^"']+)/i)?.[1] ?? ''),
      ).length,
      headingLevels: headings,
      headingOrderSkips: headings.slice(1).filter((level, index) => level > headings[index] + 1).length,
      landmarkCount: (html.match(/<(?:main|nav|header|footer|aside|section)\b/gi) ?? []).length,
      nonEmptyAltCount: images.filter((image) => /\balt\s*=\s*["'][^"']+/i.test(image)).length,
      inlineClickHandlerCount: (html.match(/\bonclick\s*=/gi) ?? []).length,
    },
    note: 'Static source baseline only; this fetcher does not execute page scripts or claim an axe-core scan.',
  }
}
