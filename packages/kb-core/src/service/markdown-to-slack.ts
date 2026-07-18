/**
 * Convert common Markdown (what chat models emit) into Slack mrkdwn.
 *
 * Slack has no ATX headers or GFM tables — those are rewritten to bold lines
 * and “ · ”-separated rows. Used by {@link formatChatReply} when `flavor: 'slack'`.
 */

const PLACEHOLDER = '\uE000'

function isBlank(line: string): boolean {
  return /^\s*$/.test(line)
}

function isUl(line: string): boolean {
  return /^\s*[-*]\s+/.test(line)
}

function isOl(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line)
}

function isHeading(line: string): RegExpExecArray | null {
  return /^(#{1,6})\s+(.+)$/.exec(line)
}

function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.indexOf('|', 1) !== -1
}

function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function splitTableCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map(c => c.trim())
}

/** Escape Slack control chars, preserving already-built `<url|label>` links. */
function escapeSlackText(text: string): string {
  const links: string[] = []
  const withSlots = text.replace(/<https?:[^>|]+\|[^>]*>/g, m => {
    const i = links.length
    links.push(m)
    return `${PLACEHOLDER}L${i}${PLACEHOLDER}`
  })
  const escaped = withSlots
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(
    new RegExp(`${PLACEHOLDER}L(\\d+)${PLACEHOLDER}`, 'g'),
    (_, i) => links[+i] ?? '',
  )
}

/** Inline markdown → Slack mrkdwn (input is a single line / cell, not a fence). */
export function inlineMarkdownToSlack(text: string): string {
  let s = text
  const bolds: string[] = []
  const codes: string[] = []

  // Protect inline code first so bold/italic don't touch it.
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    const i = codes.length
    codes.push(c)
    return `${PLACEHOLDER}C${i}${PLACEHOLDER}`
  })

  // [label](https://…) → <https://…|label>
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<$2|$1>')

  // **bold** / __bold__ → placeholders (must not be eaten by the italic pass)
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, inner) => {
    const i = bolds.length
    bolds.push(inner)
    return `${PLACEHOLDER}B${i}${PLACEHOLDER}`
  })
  s = s.replace(/__([^_]+)__/g, (_, inner) => {
    const i = bolds.length
    bolds.push(inner)
    return `${PLACEHOLDER}B${i}${PLACEHOLDER}`
  })

  // ~~strike~~ → ~strike~
  s = s.replace(/~~([^~]+)~~/g, '~$1~')

  // Remaining *italic* → Slack _italic_
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '_$1_')

  s = escapeSlackText(s)

  const escapePlain = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  s = s.replace(
    new RegExp(`${PLACEHOLDER}B(\\d+)${PLACEHOLDER}`, 'g'),
    (_, i) => `*${escapePlain(bolds[+i] ?? '')}*`,
  )
  s = s.replace(
    new RegExp(`${PLACEHOLDER}C(\\d+)${PLACEHOLDER}`, 'g'),
    (_, i) => `\`${codes[+i] ?? ''}\``,
  )
  return s
}

function tableToSlack(headers: string[], rows: string[][]): string {
  const head = headers.map(h => `*${stripWrappingStars(inlineMarkdownToSlack(h))}*`).join('  ·  ')
  const body = rows.map(row =>
    headers
      .map((_, c) => inlineMarkdownToSlack(row[c] ?? ''))
      .join('  ·  '),
  )
  return [head, ...body].join('\n')
}

function stripWrappingStars(s: string): string {
  return s.replace(/^\*([\s\S]*)\*$/, '$1')
}

/**
 * Best-effort Markdown → Slack mrkdwn for chat answers.
 * Fenced code stays fenced; headers become bold lines; tables become
 * bold-header + “ · ”-joined rows (Slack has no real tables).
 */
export function markdownToSlackMrkdwn(src: string): string {
  const fences: string[] = []
  let text = String(src || '').replace(/\r\n?/g, '\n')

  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const i = fences.length
    const body = code.replace(/\n$/, '')
    // Slack code blocks: no language tag styling; keep body intact (escape inside).
    const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    fences.push(lang ? `\`\`\`${lang}\n${escaped}\n\`\`\`` : `\`\`\`\n${escaped}\n\`\`\``)
    return `\n${PLACEHOLDER}${i}${PLACEHOLDER}\n`
  })

  const lines = text.split('\n')
  const out: string[] = []
  let i = 0

  const isFence = (line: string): string | null => {
    const m = new RegExp(`^${PLACEHOLDER}(\\d+)${PLACEHOLDER}$`).exec(line.trim())
    return m ? (fences[+m[1]] ?? null) : null
  }
  const startsTable = (idx: number): boolean =>
    isTableRow(lines[idx] ?? '') && idx + 1 < lines.length && isTableSep(lines[idx + 1] ?? '')

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = isFence(line)
    if (fence != null) {
      out.push(fence)
      i++
      continue
    }
    if (isBlank(line)) {
      // Collapse runs of blanks to a single blank in the output later
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      i++
      continue
    }

    const heading = isHeading(line)
    if (heading) {
      const title = inlineMarkdownToSlack(heading[2].trim())
      out.push(`*${stripWrappingStars(title)}*`)
      i++
      continue
    }

    if (startsTable(i)) {
      const headers = splitTableCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i] ?? '') && !isTableSep(lines[i] ?? '')) {
        rows.push(splitTableCells(lines[i] ?? ''))
        i++
      }
      out.push(tableToSlack(headers, rows))
      continue
    }

    if (isUl(line)) {
      while (i < lines.length && isUl(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^\s*[-*]\s+/, '')
        out.push(`• ${inlineMarkdownToSlack(item)}`)
        i++
      }
      continue
    }

    if (isOl(line)) {
      let n = 1
      while (i < lines.length && isOl(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^\s*\d+\.\s+/, '')
        out.push(`${n}. ${inlineMarkdownToSlack(item)}`)
        n++
        i++
      }
      continue
    }

    // Paragraph: gather until blank / block
    const para: string[] = []
    while (
      i < lines.length &&
      !isBlank(lines[i] ?? '') &&
      !isFence(lines[i] ?? '') &&
      !isHeading(lines[i] ?? '') &&
      !startsTable(i) &&
      !isUl(lines[i] ?? '') &&
      !isOl(lines[i] ?? '')
    ) {
      para.push(inlineMarkdownToSlack(lines[i] ?? ''))
      i++
    }
    out.push(para.join('\n'))
  }

  // Trim trailing blanks; keep single blank between blocks
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
