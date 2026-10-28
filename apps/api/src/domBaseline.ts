const exactAttributeValue = (tag: string, name: string): string | undefined => {
  const attribute = new RegExp(
    `(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+)))?(?=\\s|/?>|$)`,
    'i',
  ).exec(tag)
  return attribute ? attribute[1] ?? attribute[2] ?? attribute[3] ?? '' : undefined
}

const startTags = (html: string, name: string): string[] => {
  const tagPattern = new RegExp(
    `<${name}(?=\\s|/|>)(?:"[^"]*"|'[^']*'|[^'">])*?>`,
    'gi',
  )
  return [...html.matchAll(tagPattern)].map(([tag]) => tag)
}

const allStartTags = (html: string): string[] => [
  ...html.matchAll(/<[a-z][\w:-]*(?:"[^"]*"|'[^']*'|[^'">])*?>/gi),
].map(([tag]) => tag)

export const collectDomBaseline = (html: string) => {
  const images = startTags(html, 'img')
  const controls = ['input', 'select', 'textarea'].flatMap((name) => startTags(html, name))
  const headings = [1, 2, 3, 4, 5, 6].flatMap((level) =>
    startTags(html, `h${level}`).map(() => level),
  )
  const tags = allStartTags(html)
  const labelledIds = new Set(
    startTags(html, 'label').map((label) => exactAttributeValue(label, 'for')).filter(Boolean),
  )
  const htmlTag = startTags(html, 'html')[0] ?? ''
  return {
    checks: {
      pageLanguagePresent: Boolean(exactAttributeValue(htmlTag, 'lang')),
      imageCount: images.length,
      imagesWithoutAlt: images.filter((image) => exactAttributeValue(image, 'alt') === undefined).length,
      formControlCount: controls.length,
      controlsWithAccessibleLabel: controls.filter((control) =>
        Boolean(exactAttributeValue(control, 'aria-label')?.trim()) ||
        Boolean(exactAttributeValue(control, 'aria-labelledby')?.trim()) ||
        labelledIds.has(exactAttributeValue(control, 'id') ?? ''),
      ).length,
      headingLevels: headings,
      headingOrderSkips: headings.slice(1).filter((level, index) => level > headings[index] + 1).length,
      landmarkCount: tags.filter((tag) =>
        ['main', 'nav', 'header', 'footer', 'aside', 'section']
          .includes(tag.match(/^<([a-z]+)/i)?.[1]?.toLowerCase() ?? ''),
      ).length,
      nonEmptyAltCount: images.filter((image) => Boolean(exactAttributeValue(image, 'alt')?.trim())).length,
      inlineClickHandlerCount: tags.filter((tag) => exactAttributeValue(tag, 'onclick') !== undefined).length,
    },
    note: 'Static source baseline only; this fetcher does not execute page scripts or claim an axe-core scan.',
  }
}
