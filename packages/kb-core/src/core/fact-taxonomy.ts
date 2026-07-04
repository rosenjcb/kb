export type FactLaneId =
  | 'architecture'
  | 'build'
  | 'config'
  | 'platform'
  | 'contrib'
  | 'roadmap'
  | 'limitations'
  | 'general'

export interface FactLaneDefinition {
  id: FactLaneId
  keywords: string[]
}

const FACT_LANES: FactLaneDefinition[] = [
  { id: 'build', keywords: ['build', 'cmake', 'make', 'compile', 'install', 'dependency'] },
  { id: 'config', keywords: ['config', 'flag', 'option', 'define', 'setting'] },
  {
    id: 'platform',
    keywords: ['platform', 'windows', 'linux', 'macos', 'android', 'web', 'opengl'],
  },
  { id: 'architecture', keywords: ['architecture', 'module', 'design', 'api', 'system'] },
  { id: 'contrib', keywords: ['contrib', 'contributing', 'style', 'convention', 'guideline'] },
  { id: 'roadmap', keywords: ['roadmap', 'future', 'history', 'version', 'release'] },
  { id: 'limitations', keywords: ['limitation', 'constraint', 'gotcha', 'caveat', 'warning'] },
]

export function classifyFactLane(text: string): FactLaneId {
  const normalized = text.toLowerCase()
  let best: FactLaneId = 'general'
  let bestScore = 0
  for (const lane of FACT_LANES) {
    const score = lane.keywords.reduce(
      (acc, keyword) => acc + (normalized.includes(keyword) ? 1 : 0),
      0
    )
    if (score > bestScore) {
      bestScore = score
      best = lane.id
    }
  }
  return best
}

export function inferQueryLaneWeights(query: string): Partial<Record<FactLaneId, number>> {
  const normalized = query.toLowerCase()
  const weights: Partial<Record<FactLaneId, number>> = {}
  for (const lane of FACT_LANES) {
    const hits = lane.keywords.reduce(
      (acc, keyword) => acc + (normalized.includes(keyword) ? 1 : 0),
      0
    )
    if (hits > 0) {
      weights[lane.id] = Math.min(1, 0.2 + hits * 0.2)
    }
  }
  return weights
}
