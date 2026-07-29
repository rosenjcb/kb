/**
 * Ecosystem harvester contract (NOMENCLATURE_INDEX_PLAN.md §4a).
 *
 * A harvester answers "what deployable things does this repo declare" from
 * manifest-class files. It is a pure function over a scan directory: no LLM, no
 * code execution, no AST, no network. Registry shape mirrors `LANG_CONFIGS` in
 * the tree-sitter indexer — one entry per ecosystem, routed by the files it
 * finds, each degrading silently when its inputs are absent.
 */

import type { EntityKind } from '../entity-registry.js'

export interface EntityCandidate {
  kind: EntityKind
  canonicalName: string
  aliases: string[]
  /** One-line human description, when the manifest supplies one. */
  gloss?: string
  /** Repo-relative file the candidate was extracted from. */
  sourceFile: string
  sourceKind: 'manifest'
  /** 0–1. Lower it when the signal is inferred rather than declared. */
  confidence: number
  contentHash: string
  /** Which harvester produced this — provenance for merge and debugging. */
  ecosystem: string
}

export interface CandidateEdge {
  fromName: string
  toName: string
  edgeType: 'part_of' | 'belongs_to' | 'owned_by' | 'depends_on'
}

export interface HarvestResult {
  candidates: EntityCandidate[]
  edges: CandidateEdge[]
}

export interface EcosystemHarvester {
  /** Stable id — also the `ecosystem` stamped on every candidate. */
  id: string
  /**
   * Fast pre-check: repo-relative glob patterns that must match at least one
   * file for `harvest` to run at all. Keeps a scan cheap in repos that have
   * nothing to do with this ecosystem.
   */
  detect: string[]
  harvest(scanDir: string): Promise<HarvestResult>
}

export const EMPTY_HARVEST: HarvestResult = { candidates: [], edges: [] }
