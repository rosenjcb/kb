import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { FactRow } from '../tools/sqlite-kb-index'

export type FactCategoryStatus = 'accepted' | 'edited' | 'rejected' | 'inferred'
export type FactCategoryCreatedBy = 'system' | 'user'

export interface FactCategoryDefinitionInput {
  id: string
  name: string
  description: string
  status: FactCategoryStatus
  createdBy: FactCategoryCreatedBy
  representativeTerms: string[]
  centroidVector: number[]
}

export interface InferredFactCategory extends FactCategoryDefinitionInput {
  factIds: string[]
}

interface PythonDiscoverOutputCategory {
  name: string
  description: string
  representative_terms: string[]
  centroid_vector: number[]
  fact_ids: string[]
}

interface PythonAssignOutputRow {
  fact_id: string
  assignments: Array<{ category_id: string; score: number }>
}

interface PythonDiscoverAndAssignOutput {
  categories?: PythonDiscoverOutputCategory[]
  assignments?: PythonAssignOutputRow[]
}

type FactCategoryFact = Pick<
  FactRow,
  'id' | 'fact_text' | 'source_kind' | 'subject' | 'predicate' | 'object'
>

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..')
const PYTHON_CLUSTERER_PATH = path.join(REPO_ROOT, 'scripts', 'fact_categories_hdbscan.py')

export function inferFactCategories(
  facts: FactCategoryFact[],
  maxCategories = 8
): InferredFactCategory[] {
  if (facts.length === 0) return []
  const payload = {
    mode: 'discover',
    max_categories: maxCategories,
    facts: facts.map(fact => ({
      id: fact.id,
      text: buildFactCategoryDocument(fact),
    })),
  }
  const result = runFactCategoryPython(payload) as { categories?: PythonDiscoverOutputCategory[] }
  const categories = Array.isArray(result.categories) ? result.categories : []
  return categories.map(category => {
    return toInferredFactCategory(category)
  })
}

export function assignFactsToCategoryIds(
  facts: Array<Pick<FactRow, 'id' | 'fact_text' | 'subject' | 'predicate' | 'object'>>,
  categories: FactCategoryDefinitionInput[],
  threshold = 0.72
): Map<string, Array<{ categoryId: string; score: number }>> {
  const out = new Map<string, Array<{ categoryId: string; score: number }>>()
  if (facts.length === 0 || categories.length === 0) return out
  const payload = {
    mode: 'assign',
    threshold,
    facts: facts.map(fact => ({
      id: fact.id,
      text: buildFactCategoryDocument(fact),
    })),
    categories: categories.map(category => ({
      id: category.id,
      text: [category.name, category.description, ...category.representativeTerms]
        .filter(Boolean)
        .join(' '),
    })),
  }
  const result = runFactCategoryPython(payload) as { assignments?: PythonAssignOutputRow[] }
  for (const row of Array.isArray(result.assignments) ? result.assignments : []) {
    if (!Array.isArray(row.assignments) || row.assignments.length === 0) continue
    out.set(
      row.fact_id,
      row.assignments.map(assignment => ({
        categoryId: assignment.category_id,
        score: assignment.score,
      }))
    )
  }
  return out
}

export function inferAndAssignFactCategories(
  facts: FactCategoryFact[],
  maxCategories = 8,
  threshold = 0.72
): {
  categories: InferredFactCategory[]
  assignments: Map<string, Array<{ categoryId: string; score: number }>>
} {
  if (facts.length === 0) {
    return { categories: [], assignments: new Map() }
  }
  const payload = {
    mode: 'discover_and_assign',
    max_categories: maxCategories,
    threshold,
    facts: facts.map(fact => ({
      id: fact.id,
      text: buildFactCategoryDocument(fact),
    })),
  }
  const result = runFactCategoryPython(payload) as PythonDiscoverAndAssignOutput
  const categories = (Array.isArray(result.categories) ? result.categories : []).map(category =>
    toInferredFactCategory(category)
  )
  const assignments = new Map<string, Array<{ categoryId: string; score: number }>>()
  for (const row of Array.isArray(result.assignments) ? result.assignments : []) {
    if (!Array.isArray(row.assignments) || row.assignments.length === 0) continue
    assignments.set(
      row.fact_id,
      row.assignments.map(assignment => ({
        categoryId: assignment.category_id,
        score: assignment.score,
      }))
    )
  }
  return { categories, assignments }
}

export function buildCategoryDefinitionFromReview(
  category: InferredFactCategory,
  overrides?: Partial<
    Pick<FactCategoryDefinitionInput, 'name' | 'description' | 'status' | 'createdBy'>
  >
): FactCategoryDefinitionInput {
  return {
    id: category.id,
    name: overrides?.name?.trim() || category.name,
    description: overrides?.description?.trim() || category.description,
    status: overrides?.status ?? category.status,
    createdBy: overrides?.createdBy ?? category.createdBy,
    representativeTerms: [...category.representativeTerms],
    centroidVector: [...category.centroidVector],
  }
}

export function slugifyFactCategoryName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `category-${sha256(input).slice(0, 8)}`
}

function buildFactCategoryDocument(
  fact: Pick<FactRow, 'fact_text' | 'subject' | 'predicate' | 'object'>
): string {
  return [fact.fact_text, fact.subject, fact.predicate, fact.object].filter(Boolean).join(' ')
}

function toInferredFactCategory(category: PythonDiscoverOutputCategory): InferredFactCategory {
  const name = category.name.trim() || 'Inferred Category'
  return {
    id: `category-${slugifyFactCategoryName(name)}`,
    name,
    description: category.description.trim() || `Facts about ${name.toLowerCase()}`,
    status: 'inferred',
    createdBy: 'system',
    representativeTerms: category.representative_terms.filter(Boolean).slice(0, 6),
    centroidVector: category.centroid_vector,
    factIds: category.fact_ids,
  }
}

function runFactCategoryPython(payload: Record<string, unknown>): unknown {
  const pythonBinary = resolvePythonBinary()
  const raw = execFileSync(pythonBinary, [PYTHON_CLUSTERER_PATH], {
    cwd: REPO_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
    },
  }).trim()
  if (!raw) {
    throw new Error('Fact category python clusterer returned empty output.')
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Fact category python clusterer returned invalid JSON: ${message}`)
  }
}

function resolvePythonBinary(): string {
  const envOverride = process.env.KB_CATEGORY_CLUSTER_PYTHON?.trim()
  if (envOverride) return envOverride

  const localVenvPython = path.join(REPO_ROOT, '.kb-python', 'bin', 'python3')
  if (existsSync(localVenvPython)) return localVenvPython

  return 'python3'
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
