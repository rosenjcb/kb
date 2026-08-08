/**
 * Serialize an `IntentResult` into stable JSON shapes for network clients
 * (Slack / REST) and MCP. Keeps the wire contract decoupled from the internal
 * retrieval representation.
 */

import { type EvidenceLabel, isEvidenceAtLeast } from '@kb/core/core/evidence-label.js'
import type { ReadDocumentsResultData, ReadDocumentsResultItem } from '@kb/core/query/intent-cli.js'
import { type LLMFailure, describeLLMFailure } from '@kb/core/core/llm-error.js'
import type { IntentResult } from '@kb/core/intents/types.js'
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
  }
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

// ─── MCP lean response (kb_query default) ─────────────────────────────────────
//
// Agent consumers want the synthesized answer plus a handful of openable
// citations — not the fact dump or retrieval telemetry. The full payload stays
// available behind the tool's `verbose` flag (`serializeQueryResult`).

export interface McpQueryResponseBody {
  status: IntentResult['status']
  answer: string | null
  /** Compact citations, `path (symbol, …)` — open these files to verify the answer. */
  sources: string[]
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
 * File-looking tokens in `answer` whose basename matches none of the evidence
 * paths. These are the "prose cites `dto.ts`, evidence says `reversal.ts`"
 * mismatches — the caller should trust the sources list, not the prose path.
 */
export function findUngroundedFileReferences(answer: string, sourcePaths: string[]): string[] {
  const knownBasenames = new Set<string>()
  for (const p of sourcePaths) {
    const base = p.trim().toLowerCase().split('/').pop()
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
    const base = normalized.split('/').pop() ?? normalized
    if (seen.has(base)) continue
    seen.add(base)
    if (!knownBasenames.has(base)) ungrounded.push(token)
  }
  return ungrounded
}

/**
 * Compact `path (symbol, …)` citations for the lean MCP payload. Reuses the
 * canonical {@link groupSources} (drops non-openable refs, dedupes by file, folds
 * symbols) at MCP's tighter caps. No repo registry here, so no hrefs — the MCP
 * payload is repo-relative paths, which is what agents open/grep.
 */
function formatMcpSources(results: QuerySource[]): string[] {
  return groupSources(results, {
    maxSources: MCP_MAX_SOURCES,
    maxSymbolsPerSource: MCP_MAX_SYMBOLS_PER_SOURCE,
  }).map(g => (g.symbols.length > 0 ? `${g.path} (${g.symbols.join(', ')})` : g.path))
}

/**
 * Map an `IntentResult` to the trimmed MCP `kb_query` payload: answer + top
 * cited files, no fact dump, no retrieval metadata. Adds `notes` when the
 * answer needs verification (evidence below `MCP_VERIFY_EVIDENCE_FLOOR`) or when
 * the prose names files absent from the evidence.
 */
export function serializeMcpQueryResult(result: IntentResult): McpQueryResponseBody {
  const full = serializeQueryResult(result)
  const sources = formatMcpSources(full.results)
  const notes: string[] = []

  if (full.evidence && !isEvidenceAtLeast(full.evidence, MCP_VERIFY_EVIDENCE_FLOOR)) {
    notes.push(
      `Retrieval evidence was ${full.evidence} — verify the cited sources before relying on this answer.`
    )
  }

  if (full.answer) {
    const evidencePaths = full.results.flatMap(r => (r.filePath ? [r.filePath] : []))
    const ungrounded = findUngroundedFileReferences(full.answer, evidencePaths)
    if (ungrounded.length > 0) {
      notes.push(
        `The answer names file(s) not in the cited sources (${ungrounded.join(', ')}) — trust the sources list for exact paths.`
      )
    }
  } else if (full.answerError) {
    // Lead with the failure. "Open the cited sources directly" reads as a retrieval
    // verdict; an agent acting on it would wrongly conclude the KB is thin, when in
    // fact the provider call failed and a retry is what's warranted.
    notes.unshift(describeLLMFailure(full.answerError))
  } else if (sources.length > 0) {
    notes.push('No synthesized answer was produced — open the cited sources directly.')
  }

  const degraded = full.retrieval.degraded
  if (degraded && degraded.length > 0) {
    notes.push(
      `Degraded retrieval — ${degraded.map(d => `${d.stage} (${d.kind})`).join(', ')} was skipped after an LLM error, so ranking and filtering are weaker than usual.`
    )
  }

  return {
    status: full.status,
    answer: full.answer,
    sources,
    ...(full.evidence ? { evidence: full.evidence } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(full.answerError ? { answerError: full.answerError } : {}),
  }
}

/** Map an `IntentResult` to the REST `POST /v1/query` response body. */
export function serializeQueryResult(result: IntentResult): QueryResponseBody {
  const data = (result.data ?? {}) as ReadDocumentsResultData
  const results = Array.isArray(data.results) ? data.results : []

  const degraded = data.retrieval?.degraded
  const querySources = results.map(toSource)
  return {
    status: result.status,
    answer: data.answer?.trim() || null,
    sources: groupSources(querySources),
    results: querySources,
    retrieval: {
      method: data.retrieval?.method,
      detail: data.retrieval?.detail,
      ...(degraded && degraded.length > 0 ? { degraded } : {}),
    },
    ...(result.evidence ? { evidence: result.evidence } : {}),
    ...(data.answerError ? { answerError: data.answerError } : {}),
    ...(typeof data.traceFile === 'string' && data.traceFile ? { traceFile: data.traceFile } : {}),
  }
}
