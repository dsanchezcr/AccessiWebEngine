const exactAttributeValue = (tag: string, name: string): string | undefined => {
  const tagName = tag.match(/^<[^\s/>]+/)?.[0]
  if (!tagName) return undefined
  let cursor = tagName.length

  while (cursor < tag.length) {
    while (/\s/.test(tag[cursor] ?? '')) cursor += 1
    if (tag[cursor] === '/' || tag[cursor] === '>') break
    const nameStart = cursor
    while (cursor < tag.length && !/[\s=/>]/.test(tag[cursor])) cursor += 1
    if (cursor === nameStart) {
      cursor += 1
      continue
    }
    const attributeName = tag.slice(nameStart, cursor).toLowerCase()
    while (/\s/.test(tag[cursor] ?? '')) cursor += 1
    let value = ''
    if (tag[cursor] === '=') {
      cursor += 1
      while (/\s/.test(tag[cursor] ?? '')) cursor += 1
      const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor] : ''
      if (quote) {
        cursor += 1
        const valueStart = cursor
        while (cursor < tag.length && tag[cursor] !== quote) cursor += 1
        value = tag.slice(valueStart, cursor)
        if (tag[cursor] === quote) cursor += 1
      } else {
        const valueStart = cursor
        while (cursor < tag.length && !/[\s>]/.test(tag[cursor])) cursor += 1
        value = tag.slice(valueStart, cursor)
      }
    }
    if (attributeName === name.toLowerCase()) return value
  }
  return undefined
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
  const headings = startTags(html, 'h[1-6]').map((tag) => Number(tag[2]))
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
      headingLevels: headings.slice(0, 100),
      headingLevelsTruncated: headings.length > 100,
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
