/**
 * Serialize an `IntentResult` into stable JSON shapes for network clients
 * (Slack / REST) and MCP. Keeps the wire contract decoupled from the internal
 * retrieval representation.
 */

import {
  type EvidenceLabel,
  isEvidenceAtLeast,
  weakestEvidence,
} from '@kb/core/core/evidence-label.js'
import type { ReadDocumentsResultData, ReadDocumentsResultItem } from '@kb/core/query/intent-cli.js'
import { type LLMFailure, describeLLMFailure } from '@kb/core/core/llm-error.js'
import type { IntentResult } from '@kb/core/intents/types.js'
import type { ChatSourceRepo } from './chat-reply.js'
import { type GroupedSource, groupSources } from './source-grouping.js'

export interface QuerySource {
  id?: string
  title?: string
  /**
   * Openable location of the evidence: the physical source file the fact was
   * extracted from when known, otherwise the fact's `fact://` id as a last resort.
   * Multi-repo bases usually prefix with `<gitRepo>/…`.
   */
  filePath?: string
  /**
   * Origin repo slug (`facts.git_repo` / clone dir name). Lets consumers build
   * per-repo blob links without re-parsing `filePath`.
   */
  gitRepo?: string
  /** For code facts, the exported symbol the fact describes. */
  symbol?: string
  tags?: string[]
  snippet?: string
}

export interface QueryResponseBody {
  status: IntentResult['status']
  answer: string | null
  /**
   * Source-centric citations: the ranked *files*, each with its folded fact
   * subjects. This is what surfaces should show. Prefer this over `results`.
   */
  sources: GroupedSource[]
  /** Raw per-fact rows (one per symbol/chunk). Kept for verbose/programmatic use. */
  results: QuerySource[]
  retrieval: {
    method?: string
    detail?: string
    /** Best-effort LLM stages that failed and were skipped; retrieval still succeeded. */
    degraded?: LLMFailure[]
    /** Prose claims the opt-in verification pass judged unsupported by the evidence (#223). */
    unsupportedClaims?: string[]
  }
  /**
   * Actionable caveats every surface should show: verify hints, ungrounded-file /
   * unsupported-claim warnings, degraded-retrieval and no-answer notices. Computed
   * once here so REST, MCP, CLI, TUI, and the demo all carry the same caveats — the
   * surfaces differ only in how they render them, never in whether they exist.
   */
  notes?: string[]
  /**
   * Evidence label, already downgraded when grounding checks fired (an answer that
   * cites files absent from the sources, or makes claims the sources don't support,
   * is never `strong` no matter how many results came back).
   */
  evidence?: EvidenceLabel
  /**
   * Why no answer came back. Present only when synthesis was attempted and failed, so
   * `answer: null` alone never has to be interpreted — a provider outage is legible as
   * an outage instead of reading as "the knowledge base had nothing to say".
   */
  answerError?: LLMFailure
  /** Server-side path to the deep trace dump when `trace: true` was requested. */
  traceFile?: string
}

const SNIPPET_MAX_CHARS = 280

function buildSnippet(content: string | undefined): string | undefined {
  if (!content) return undefined
  const normalized = content
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        line.length > 0 &&
        !line.startsWith('#') &&
        !line.startsWith('Created:') &&
        !line.startsWith('Tags:') &&
        !line.startsWith('Type:')
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined
  return normalized.length <= SNIPPET_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, SNIPPET_MAX_CHARS - 1)}…`
}

function gitRepoFromItem(item: ReadDocumentsResultItem): string | undefined {
  const direct = item.metadata?.gitRepo?.trim()
  if (direct) return direct
  // tags are typically `[source_kind, git_repo, 'fact']` — prefer an explicit field.
  const tags = item.metadata?.tags
  if (!Array.isArray(tags)) return undefined
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const t = tag.trim()
    if (!t || t === 'fact' || t.startsWith('import_')) continue
    // Heuristic: slug-like tag that also prefixes sourcePath.
    const location = item.metadata?.sourcePath ?? item.metadata?.filePath
    if (location?.startsWith(`${t}/`) || location === t) return t
  }
  return undefined
}

export function toSource(item: ReadDocumentsResultItem): QuerySource {
  // Prefer the physical source file (what an agent can open/grep) over the
  // opaque `fact://` URI; fall back to the URI only when provenance is unknown.
  const location = item.metadata?.sourcePath ?? item.metadata?.filePath
  const gitRepo = gitRepoFromItem(item)
  return {
    id: item.metadata?.id,
    title: item.metadata?.title,
    filePath: location,
    ...(gitRepo ? { gitRepo } : {}),
    ...(item.metadata?.symbol ? { symbol: item.metadata.symbol } : {}),
    tags: item.metadata?.tags,
    snippet: buildSnippet(item.content),
  }
}

// ─── Lean agent response (query / REST default) ────────────────────────────
//
// Agent consumers want the synthesized answer plus a handful of openable
// citations — not the fact dump or retrieval telemetry. The full payload stays
// available behind `verbose: true` (`serializeQueryResult`).

/** Lean citation: openable path + optional folded symbols. No facts/ids/snippets. */
export interface McpSource {
  path: string
  /** Distinct fact subjects when known; omitted when empty. */
  symbols?: string[]
}

export interface McpQueryResponseBody {
  status: IntentResult['status']
  answer: string | null
  /** Lean file citations — open these to verify the answer. */
  sources: McpSource[]
  evidence?: EvidenceLabel
  /** Actionable caveats: verify hints, answer/evidence path mismatches. */
  notes?: string[]
  /**
   * Why synthesis produced no answer. An agent that sees this must not conclude the
   * knowledge base lacks the information — the retrieval below is real; only the
   * answer-writing step failed.
   */
  answerError?: LLMFailure
}

const MCP_MAX_SOURCES = 5
const MCP_MAX_SYMBOLS_PER_SOURCE = 3
/** Below this, tell the caller to verify the cited files before relying on the answer. */
/** Answers below this evidence bar carry a verify note in the MCP payload. */
const MCP_VERIFY_EVIDENCE_FLOOR: EvidenceLabel = 'strong'

/** File extensions that make a token in prose read as a source-file reference. */
const FILE_REF_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
  'php',
  'cs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'swift',
  'scala',
  'sql',
  'sh',
  'bash',
  'md',
  'json',
  'yaml',
  'yml',
  'toml',
  'css',
  'scss',
  'html',
  'vue',
  'svelte',
  'proto',
  'tf',
  'ini',
  'env',
])

/** Prose tokens that look like files but are product names, never citations. */
const NON_FILE_TOKENS = new Set([
  'node.js',
  'next.js',
  'vue.js',
  'nuxt.js',
  'express.js',
  'three.js',
  'd3.js',
  'ember.js',
  'backbone.js',
  'chart.js',
])

/**
 * File-looking tokens in `answer` that don't match any evidence path. These are
 * the "prose cites `dto.ts`, evidence says `reversal.ts`" mismatches — the
 * caller should trust the sources list, not the prose path.
 *
 * A token with a directory component (`src/dto.ts`) must match a known path
 * exactly or as a path suffix — basename-only would let `src/dto.ts` pass as
 * grounded off of an unrelated `lib/dto.ts` source. A bare filename (`dto.ts`,
 * no `/`) still matches on basename alone since prose commonly omits the path.
 */
export function findUngroundedFileReferences(answer: string, sourcePaths: string[]): string[] {
  const knownBasenames = new Set<string>()
  const knownPaths = new Set<string>()
  for (const p of sourcePaths) {
    const normalizedPath = p.trim().toLowerCase()
    if (!normalizedPath) continue
    knownPaths.add(normalizedPath)
    const base = normalizedPath.split('/').pop()
    if (base) knownBasenames.add(base)
  }
  const tokens = answer.match(/[\w@][\w.@/-]*\.[A-Za-z]+/g) ?? []
  const ungrounded: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const normalized = token.replace(/^\.?\//, '').toLowerCase()
    if (NON_FILE_TOKENS.has(normalized)) continue
    const ext = normalized.split('.').pop()
    if (!ext || !FILE_REF_EXTENSIONS.has(ext)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const hasPath = normalized.includes('/')
    const grounded = hasPath
      ? knownPaths.has(normalized) ||
        [...knownPaths].some(p => p.endsWith(`/${normalized}`))
      : knownBasenames.has(normalized)
    if (!grounded) ungrounded.push(token)
  }
  return ungrounded
}

/**
 * Lean `{ path, symbols? }` citations for the agent payload. Reuses the
 * canonical {@link groupSources} (drops non-openable refs, dedupes by file, folds
 * symbols) at MCP's tighter caps. Omits label/gitRepo/href/facts/factCount — those
 * are verbose-only. Empty `symbols` is omitted to save tokens.
 */
function formatMcpSources(results: QuerySource[]): McpSource[] {
  return groupSources(results, {
    maxSources: MCP_MAX_SOURCES,
    maxSymbolsPerSource: MCP_MAX_SYMBOLS_PER_SOURCE,
  }).map(g =>
    g.symbols.length > 0 ? { path: g.path, symbols: g.symbols } : { path: g.path }
  )
}

/**
 * The single grounding computation shared by every surface: caveats (`notes`) and
 * the evidence label after grounding downgrades. Runs once inside
 * {@link serializeQueryResult} so the REST body, the MCP projection, and the human
 * CLI/TUI all carry identical semantics — they differ only in rendering.
 */
function computeQueryGrounding(params: {
  answer: string | null
  evidence?: EvidenceLabel
  /** Openable paths of the cited evidence, for the ungrounded-file check. */
  evidencePaths: string[]
  unsupportedClaims: string[]
  degraded?: LLMFailure[]
  answerError?: LLMFailure
  hasSources: boolean
}): { notes: string[]; evidence?: EvidenceLabel } {
  const notes: string[] = []
  let evidence = params.evidence

  // Floor note uses the *original* label: a `strong` answer later downgraded by a
  // grounding check gets the sharper ungrounded/claims note below, not this one.
  if (evidence && !isEvidenceAtLeast(evidence, MCP_VERIFY_EVIDENCE_FLOOR)) {
    notes.push(
      `Retrieval evidence was ${evidence} — verify the cited sources before relying on this answer.`
    )
  }

  if (params.answer) {
    const ungrounded = findUngroundedFileReferences(params.answer, params.evidencePaths)
    if (ungrounded.length > 0) {
      notes.push(
        `The answer names file(s) not in the cited sources (${ungrounded.join(', ')}) — trust the sources list for exact paths.`
      )
      // An answer that cites a file the retrieval never surfaced isn't "strong"
      // evidence no matter how many results came back — downgrade rather than
      // let a note-only warning coexist with an unchanged top-level label.
      if (evidence) evidence = weakestEvidence([evidence, 'weak'])
    }

    // Prose claims the opt-in verification pass judged unsupported by the evidence
    // (#223). Same posture as the ungrounded-file check above: a confidently-wrong
    // prose claim ("import POSTs to the backend") must not sail through with a
    // `strong` label just because its cited file names were real.
    if (params.unsupportedClaims.length > 0) {
      notes.push(
        `The answer makes claim(s) the cited sources do not directly support: ${params.unsupportedClaims.join('; ')} — verify against the sources before relying on this.`
      )
      if (evidence) evidence = weakestEvidence([evidence, 'weak'])
    }
  } else if (params.answerError) {
    // Lead with the failure. "Open the cited sources directly" reads as a retrieval
    // verdict; an agent acting on it would wrongly conclude the KB is thin, when in
    // fact the provider call failed and a retry is what's warranted.
    notes.unshift(describeLLMFailure(params.answerError))
  } else if (params.hasSources) {
    notes.push('No synthesized answer was produced — open the cited sources directly.')
  }

  if (params.degraded && params.degraded.length > 0) {
    notes.push(
      `Degraded retrieval — ${params.degraded.map(d => `${d.stage} (${d.kind})`).join(', ')} was skipped after an LLM error, so ranking and filtering are weaker than usual.`
    )
  }

  return { notes, evidence }
}

/** Options shared by both serializers. */
export interface SerializeQueryOptions {
  /**
   * Per-repo registry (`chatSourceReposFromBaseRepos(discoverBaseRepos(baseDir))`)
   * used to build clickable blob `href`s on the grouped sources. Omit for a
   * single-base server with no remote, or when links aren't wanted.
   */
  sourceRepos?: ChatSourceRepo[]
}

/**
 * Project the canonical {@link serializeQueryResult} body onto the trimmed agent
 * payload (MCP `query` default and REST without `verbose`): answer + top cited
 * files + the shared `notes`/`evidence`. Pure projection — all grounding logic
 * lives in {@link serializeQueryResult}, so this surface can never diverge from it.
 */
export function serializeMcpQueryResult(
  result: IntentResult,
  options?: SerializeQueryOptions
): McpQueryResponseBody {
  const full = serializeQueryResult(result, options)
  return {
    status: full.status,
    answer: full.answer,
    sources: formatMcpSources(full.results),
    ...(full.evidence ? { evidence: full.evidence } : {}),
    ...(full.notes && full.notes.length > 0 ? { notes: full.notes } : {}),
    ...(full.answerError ? { answerError: full.answerError } : {}),
  }
}

/**
 * Map an `IntentResult` to the canonical `POST /v1/query` response body — the
 * single source of truth every surface renders from. Sources are grouped with
 * blob `href`s (when `sourceRepos` is given) and grounding caveats + the
 * downgraded evidence label are computed once here.
 */
export function serializeQueryResult(
  result: IntentResult,
  options?: SerializeQueryOptions
): QueryResponseBody {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []

  const degraded = data.retrieval?.degraded
  const unsupportedClaims = data.retrieval?.unsupportedClaims ?? []
  const querySources = results.map(toSource)
  const sources = groupSources(querySources, { sourceRepos: options?.sourceRepos })
  const answer = data.answer?.trim() || null

  const { notes, evidence } = computeQueryGrounding({
    answer,
    evidence: result.evidence,
    evidencePaths: querySources.flatMap(r => (r.filePath ? [r.filePath] : [])),
    unsupportedClaims,
    degraded,
    answerError: data.answerError,
    hasSources: sources.length > 0,
  })

  return {
    status: result.status,
    answer,
    sources,
    results: querySources,
    retrieval: {
      method: data.retrieval?.method,
      detail: data.retrieval?.detail,
      ...(degraded && degraded.length > 0 ? { degraded } : {}),
      ...(unsupportedClaims.length > 0 ? { unsupportedClaims } : {}),
    },
    ...(notes.length > 0 ? { notes } : {}),
    ...(evidence ? { evidence } : {}),
    ...(data.answerError ? { answerError: data.answerError } : {}),
    ...(typeof data.traceFile === 'string' && data.traceFile ? { traceFile: data.traceFile } : {}),
  }
}
