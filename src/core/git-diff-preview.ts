export function renderNewFileDiff(filePath: string, content: string): string {
  const plusLines = content
    .split('\n')
    .map(line => `+${line}`)
    .join('\n')
  return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split('\n').length} @@\n${plusLines}`
}

export function renderTextDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const max = Math.max(beforeLines.length, afterLines.length)
  const rows: string[] = []
  for (let i = 0; i < max; i += 1) {
    const left = beforeLines[i]
    const right = afterLines[i]
    if (left === right) continue
    if (left !== undefined) rows.push(`-${left}`)
    if (right !== undefined) rows.push(`+${right}`)
  }
  const body = rows.length > 0 ? rows.join('\n') : '+'
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n${body}`
}

export function renderDiffBundle(sections: string[], emptyMessage: string): string {
  return sections.length > 0 ? sections.join('\n\n') : emptyMessage
}
