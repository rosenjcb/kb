/** Terminal `evidence>` summary — one scannable header; per-fact lines omitted. */

const SOURCE_KINDS = new Set(['import_doc', 'import_code'])

const SOURCE_KIND_LABELS: Record<string, string> = {
  import_doc: 'doc',
  import_code: 'code',
}

export interface EvidenceSummaryFact {
  metadata?: {
    id?: string
    title?: string
    tags?: string[]
  }
}

export interface EvidenceSummaryRetrieval {
  detail?: string
  checkpoints?: Array<{ confidence?: number; status?: string }>
}

export interface EvidenceSummaryInput {
  results: EvidenceSummaryFact[]
  retrieval?: EvidenceSummaryRetrieval
}

export interface EvidenceSummaryParts {
  count: number
  sourceMix: string
  themes: string[]
  leads: string[]
  walk: string
  stop?: string
  confidence?: number
}

export function formatEvidenceSummaryHeader(input: EvidenceSummaryInput): string | undefined {
  const parts = buildEvidenceSummaryParts(input)
  if (!parts || parts.count === 0) return undefined

  const segments: string[] = [
    `${parts.count} facts → LLM (full text)`,
    parts.sourceMix,
  ]

  if (parts.themes.length > 0) {
    segments.push(`themes: ${parts.themes.join(', ')}`)
  }
  if (parts.leads.length > 0) {
    segments.push(`leads: ${parts.leads.join(', ')}`)
  }
  if (parts.walk) {
    segments.push(`walk: ${parts.walk}`)
  }
  if (parts.stop) {
    segments.push(`stop: ${parts.stop}`)
  }
  if (typeof parts.confidence === 'number') {
    segments.push(`conf: ${parts.confidence.toFixed(2)}`)
  }

  return segments.join(' · ')
}

export function buildEvidenceSummaryParts(
  input: EvidenceSummaryInput
): EvidenceSummaryParts | undefined {
  const results = Array.isArray(input.results) ? input.results : []
  if (results.length === 0) return undefined

  const sourceCounts = new Map<string, number>()
  const themeCounts = new Map<string, number>()
  const leads: string[] = []
  const seenLeadKeys = new Set<string>()

  for (const item of results) {
    const tags = item.metadata?.tags ?? []
    const sourceKind = tags.find(tag => SOURCE_KINDS.has(tag))
    if (sourceKind) {
      sourceCounts.set(sourceKind, (sourceCounts.get(sourceKind) ?? 0) + 1)
    }
    for (const theme of themesFromTags(tags)) {
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1)
    }
    const lead = formatLeadTitle(item.metadata?.title?.trim())
    if (lead) {
      const key = lead.toLowerCase()
      if (!seenLeadKeys.has(key)) {
        seenLeadKeys.add(key)
        leads.push(lead)
      }
    }
  }

  return {
    count: results.length,
    sourceMix: formatSourceMix(sourceCounts, results.length),
    themes: topThemes(themeCounts, 4),
    leads: leads.slice(0, 3),
    walk: formatRetrievalWalk(input.retrieval?.detail),
    stop: parseRetrievalStop(input.retrieval?.detail),
    confidence: lastCheckpointConfidence(input.retrieval?.checkpoints),
  }
}

function themesFromTags(tags: string[]): string[] {
  return tags.filter(tag => tag !== 'fact' && !SOURCE_KINDS.has(tag))
}

function formatSourceMix(sourceCounts: Map<string, number>, total: number): string {
  if (sourceCounts.size === 0) return 'mix: unknown'
  const parts = [...sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${SOURCE_KIND_LABELS[kind] ?? kind}`)
  if (parts.length === 1 && sourceCounts.size === 1) {
    const [kind, count] = [...sourceCounts.entries()][0]
    if (count === total) {
      return `mix: all ${SOURCE_KIND_LABELS[kind] ?? kind}`
    }
  }
  return `mix: ${parts.join(' · ')}`
}

function topThemes(themeCounts: Map<string, number>, limit: number): string[] {
  return [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([theme]) => theme)
}

function formatLeadTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  const normalized = title.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length <= 56 ? normalized : `${normalized.slice(0, 53)}…`
}

function parseRetrievalStop(detail?: string): string | undefined {
  if (!detail) return undefined
  const match = detail.match(/(?:^|;)stop:([^;]+)/)
  return match?.[1]?.trim() || undefined
}

function formatRetrievalWalk(detail?: string): string {
  if (!detail) return ''
  const passes = detail.match(/(?:^|;)passes:(\d+)/)?.[1]
  const hops = detail.match(/(?:^|;)graph_hops:(\d+)/)?.[1]
  const ponds = detail.match(/(?:^|;)ponds:(\d+)/)?.[1]
  const chunks: string[] = []
  if (passes) chunks.push(`${passes}p`)
  if (hops) chunks.push(`${hops}h`)
  if (ponds) chunks.push(`${ponds} ponds`)
  return chunks.join('/')
}

function lastCheckpointConfidence(
  checkpoints: EvidenceSummaryRetrieval['checkpoints']
): number | undefined {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return undefined
  for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
    const value = checkpoints[i]?.confidence
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}
