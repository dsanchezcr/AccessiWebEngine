import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { WEB_SCAN_LIMITS } from '../../shared/src/scanLimits.ts'

export const prepareWebSnapshot = (html: string) => {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const pending: DefaultTreeAdapterTypes.Node[] = [document]
  const replacements: Array<{ start: number; end: number; text: string }> = []
  while (pending.length) {
    const node = pending.pop()!
    const location = node.sourceCodeLocation
    if (node.nodeName === '#comment' && location) {
      replacements.push({ start: location.startOffset, end: location.endOffset, text: '' })
      continue
    }
    if ('tagName' in node) {
      if (node.tagName === 'script' && location) {
        const end = node.childNodes.reduce(
          (offset, child) => Math.max(offset, child.sourceCodeLocation?.endOffset ?? 0),
          Math.max(location.endOffset, node.sourceCodeLocation?.startTag?.endOffset ?? 0),
        )
        replacements.push({ start: location.startOffset, end, text: '' })
        continue
      }
      for (const attribute of node.attrs) {
        const name = attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name
        const attributeLocation = node.sourceCodeLocation?.attrs?.[name]
        if (attributeLocation && /^\s*data:/i.test(attribute.value)) {
          replacements.push({
            start: attributeLocation.startOffset,
            end: attributeLocation.endOffset,
            text: `${name}="data:[omitted]"`,
          })
        }
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) pending.push(child)
    }
    if ('content' in node) pending.push(node.content)
  }

  // Keep original markup (including defects); serializing the parsed tree would repair it.
  const parts: string[] = []
  let cursor = 0
  for (const { start, end, text } of replacements.sort((left, right) => left.start - right.start)) {
    if (start < cursor) continue
    parts.push(html.slice(cursor, start), text)
    cursor = end
  }
  parts.push(html.slice(cursor))
  const compacted = parts.join('')
  return {
    html: compacted.slice(0, WEB_SCAN_LIMITS.maxModelCharacters),
    truncated: compacted.length > WEB_SCAN_LIMITS.maxModelCharacters,
  }
}
