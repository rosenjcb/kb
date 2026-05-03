import { readPromptAssetUtf8 } from '../prompts/prompt-assets'
import { DOC_TYPES, type DocType, isDocType } from './doc-taxonomy'

export interface QuestionnaireItem {
  key: string
  question: string
}

/**
 * Load static checklist for a `DocType` from `src/prompts/doc-questionnaires/<type>.md`.
 *
 * Each non-comment line must look like `- key: question text`.
 */
export function loadQuestionnaire(docType: DocType): QuestionnaireItem[] {
  const raw = readPromptAssetUtf8('doc-questionnaires', `${docType}.md`)
  const items: QuestionnaireItem[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^-\s*([^:]+?)\s*:\s*(.+)$/)
    if (!m) {
      throw new Error(
        `doc-questionnaires/${docType}.md: invalid line (expected "- key: question"): ${trimmed}`
      )
    }
    items.push({ key: m[1].trim(), question: m[2].trim() })
  }

  if (items.length === 0) {
    throw new Error(`doc-questionnaires/${docType}.md: no questions defined`)
  }

  return items
}

export function parseDocTypeFlag(value: string): DocType {
  const v = value.trim().toLowerCase()
  if (!isDocType(v)) {
    throw new Error(`Invalid --type "${value}". Must be one of: ${DOC_TYPES.join(', ')}`)
  }
  return v
}
