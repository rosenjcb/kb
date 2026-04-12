export type RetrievalLane =
  | 'error-runbook'
  | 'fact'
  | 'policy'
  | 'architecture'
  | 'session-log'
  | 'workflow'

const OPERATIONAL_PATTERN = /(error|incident|outage|runbook|alert|failure|failed|exception|stack|debug|fix|restart|recovery|sev[0-9])/
const POLICY_PATTERN = /(policy|permission|allow|deny|rule|rules|compliance|guardrail|required|must|forbid)/
const ARCHITECTURE_PATTERN = /(architecture|design|schema|index|migration|runtime|component|system\s+design|how\s+it\s+works)/
const PROJECT_OVERVIEW_PATTERN = /(project\s+about|what\s+is\s+this\s+project|what\s+does\s+this\s+project|overview|high\s+level|overall)/
const CHANGE_DIFF_PATTERN = /(change\s+diff|what\s+changed|diff|changelog|session\s+log|history|timeline)/

export interface LaneRoutingDecision {
  lanes: RetrievalLane[]
  fallbackLanes: RetrievalLane[]
  lastResortLanes?: RetrievalLane[]
  reason: string
}

export function classifyDocumentLane(
  id: string,
  title: string,
  docType: string | null,
  tags: string[],
  filePath: string,
): RetrievalLane {
  const normalized = `${id} ${title} ${docType ?? ''} ${tags.join(' ')} ${filePath}`.toLowerCase()

  if (normalized.includes('session-log')) return 'session-log'
  if (/(error|incident|runbook|alert|outage|ops)/.test(normalized)) return 'error-runbook'
  if (/(policy|precedence|rule|compliance|guardrail)/.test(normalized)) return 'policy'
  if (/(architecture|design|schema|index|migration|runtime)/.test(normalized)) return 'architecture'
  if (/(workflow|checklist|process|playbook)/.test(normalized)) return 'workflow'
  return 'fact'
}

export function routeQueryToLanes(query: string): LaneRoutingDecision {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim()

  if (CHANGE_DIFF_PATTERN.test(normalized)) {
    return {
      lanes: ['session-log', 'workflow', 'fact'],
      fallbackLanes: ['architecture'],
      lastResortLanes: [],
      reason: 'change-diff-signals',
    }
  }

  if (OPERATIONAL_PATTERN.test(normalized)) {
    return {
      lanes: ['error-runbook', 'fact', 'policy'],
      fallbackLanes: ['workflow', 'architecture'],
      lastResortLanes: ['session-log'],
      reason: 'operational-signals',
    }
  }

  if (POLICY_PATTERN.test(normalized)) {
    return {
      lanes: ['policy', 'fact'],
      fallbackLanes: ['architecture', 'workflow'],
      lastResortLanes: ['session-log'],
      reason: 'policy-signals',
    }
  }

  if (ARCHITECTURE_PATTERN.test(normalized)) {
    return {
      lanes: ['architecture', 'fact', 'workflow'],
      fallbackLanes: ['policy'],
      lastResortLanes: ['session-log'],
      reason: 'architecture-signals',
    }
  }

  if (PROJECT_OVERVIEW_PATTERN.test(normalized)) {
    return {
      lanes: ['fact', 'architecture', 'workflow'],
      fallbackLanes: ['policy'],
      lastResortLanes: ['session-log'],
      reason: 'project-overview-signals',
    }
  }

  return {
    lanes: ['fact', 'architecture', 'workflow'],
    fallbackLanes: ['policy'],
    lastResortLanes: ['session-log'],
    reason: 'default-general-signals',
  }
}

export function laneFitnessBoost(lane: RetrievalLane | undefined, lanes: RetrievalLane[]): number {
  if (!lane || lanes.length === 0) return 0
  const index = lanes.indexOf(lane)
  if (index < 0) return 0

  // Prefer earlier routed lanes while keeping lexical/vector evidence primary.
  if (index === 0) return 0.15
  if (index === 1) return 0.1
  if (index === 2) return 0.05
  return 0.02
}