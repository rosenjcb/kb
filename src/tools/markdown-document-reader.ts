/**
 * Document reader for querying markdown-based KB
 * See: Ticket 008 - Query Documents Tool Contract
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'

export interface QueryDocumentsInput {
  query?: string
  mode?: 'id' | 'title' | 'tags'
  tags?: string[]
  type?: 'architecture' | 'decision' | 'checklist' | 'runbook' | 'reference'
  limit?: number
  includeContent?: boolean
}

export interface DocumentMetadata {
  id: string
  title: string
  filePath: string
  createdAt: string
  updatedAt: string
  tags?: string[]
  type?: QueryDocumentsInput['type']
}

export interface QueryResult {
  metadata: DocumentMetadata
  content?: string
}

export interface QueryResponse {
  results: QueryResult[]
  total: number
}

/**
 * Parses document metadata from markdown file
 */
function parseDocumentMetadata(filePath: string, content: string): DocumentMetadata | null {
  const lines = content.split('\n')
  
  // First line must be H1 (title)
  if (!lines[0].startsWith('# ')) {
    return null
  }
  
  const title = lines[0].replace(/^# /, '').trim()
  const id = path.basename(filePath, '.md')
  
  // Parse Created timestamp (should be in first few lines)
  let createdAt = dayjs().toISOString()
  let updatedAt = dayjs().toISOString()
  let tags: string[] | undefined
  let type: QueryDocumentsInput['type']
  
  for (let i = 1; i < Math.min(10, lines.length); i++) {
    const line = lines[i].trim()
    if (line.startsWith('Created:')) {
      createdAt = line.replace('Created:', '').trim()
    }
    if (line.startsWith('Tags:')) {
      const tagsStr = line.replace('Tags:', '').trim()
      tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean)
    }
    if (line.startsWith('Type:')) {
      const parsedType = line.replace('Type:', '').trim()
      if (['architecture', 'decision', 'checklist', 'runbook', 'reference'].includes(parsedType)) {
        type = parsedType as QueryDocumentsInput['type']
      }
    }
  }
  
  return {
    id,
    title,
    filePath,
    createdAt,
    updatedAt,
    tags,
    type,
  }
}

export class MarkdownDocumentReader {
  constructor(private baseDir: string) {}

  async queryDocuments(input: QueryDocumentsInput): Promise<QueryResponse> {
    const limit = input.limit ?? 10
    let results: QueryResult[] = []

    try {
      const files = await readdir(this.baseDir)
      const mdFiles = files.filter(f => f.endsWith('.md') && f !== '_table.md')

      for (const file of mdFiles) {
        const filePath = path.join(this.baseDir, file)
        const content = await readFile(filePath, 'utf8')
        const metadata = parseDocumentMetadata(filePath, content)

        if (!metadata) continue

        const matchesType = !input.type || metadata.type === input.type
        if (!matchesType) continue

        // Filter by query and mode
        if (input.query && input.mode === 'id') {
          if (metadata.id === input.query) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        } else if (input.query && input.mode === 'title') {
          if (metadata.title.toLowerCase().includes(input.query.toLowerCase())) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        } else if (input.tags?.length) {
          // AND logic: all provided tags must be in document
          const hasAllTags = input.tags.every(tag =>
            metadata.tags?.some(t => t.toLowerCase() === tag.toLowerCase())
          )
          if (hasAllTags) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        } else if (!input.query && !input.tags?.length) {
          // No filter: return all (recent first)
          results.push({
            metadata,
            content: input.includeContent ? content : undefined,
          })
        } else if (input.query && !input.mode) {
          // Auto-mode: try ID first, then title
          if (metadata.id === input.query) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          } else if (metadata.title.toLowerCase().includes(input.query.toLowerCase())) {
            results.push({
              metadata,
              content: input.includeContent ? content : undefined,
            })
          }
        }

        if (results.length >= limit) break
      }
    } catch {
      // KB directory doesn't exist or is empty; return empty results
      return { results: [], total: 0 }
    }

    return {
      results: results.slice(0, limit),
      total: results.length,
    }
  }
}
