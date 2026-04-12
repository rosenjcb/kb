import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'
import type {
  AppendToDocumentInput,
  DocumentWriterExtended,
  MergeDocumentsInput,
  MergeDocumentsResult,
  PruneDocumentInput,
  UpdateDocumentInput,
  WriteDocumentInput,
  WriteDocumentResult,
} from './document-writer'
import {
  appendToDocument as appendToDocumentImpl,
  mergeDocuments as mergeDocumentsImpl,
  pruneDocument as pruneDocumentImpl,
  updateDocument as updateDocumentImpl,
} from './specialized-document-tools'

const INDEX_FILE_NAME = '_table.md'

export interface MarkdownMDWriterToolOptions {
  baseDir?: string
}

/**
 * Markdown-backed document writer.
 * Persists one document per file and keeps a tiny markdown index table.
 */
export class MarkdownMDWriterTool implements DocumentWriterExtended {
  private readonly baseDir: string

  constructor(options: MarkdownMDWriterToolOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(process.cwd(), 'sessions', 'documents')
  }

  async writeDocument(input: WriteDocumentInput): Promise<WriteDocumentResult> {
    await mkdir(this.baseDir, { recursive: true })

    const now = dayjs().toISOString()
    const id = sanitizeId(input.documentId ?? input.title)
    const filePath = path.join(this.baseDir, `${id}.md`)
    let writtenPath = filePath

    const content = this.renderDocument(input, now)
    if (input.overwrite ?? false) {
      await writeFile(filePath, content, 'utf8')
    } else {
      await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' }).catch(async err => {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err
        }

        const suffix = dayjs().valueOf().toString(36)
        const uniquePath = path.join(this.baseDir, `${id}-${suffix}.md`)
        await writeFile(uniquePath, content, 'utf8')
        writtenPath = uniquePath
      })
    }

    const result: WriteDocumentResult = {
      id: path.basename(writtenPath, '.md'),
      title: input.title,
      filePath: writtenPath,
      createdAt: now,
      updatedAt: now,
    }

    await this.upsertIndex(result)
    return result
  }

  async appendToDocument(input: AppendToDocumentInput): Promise<WriteDocumentResult> {
    await mkdir(this.baseDir, { recursive: true })
    const result = await appendToDocumentImpl(input, this.baseDir)
    await this.upsertIndex(result)
    return result
  }

  async updateDocument(input: UpdateDocumentInput): Promise<WriteDocumentResult> {
    await mkdir(this.baseDir, { recursive: true })
    const result = await updateDocumentImpl(input, this.baseDir)
    await this.upsertIndex(result)
    return result
  }

  async pruneDocument(input: PruneDocumentInput): Promise<WriteDocumentResult> {
    await mkdir(this.baseDir, { recursive: true })
    const result = await pruneDocumentImpl(input, this.baseDir)
    await this.upsertIndex(result)
    return result
  }

  async mergeDocuments(input: MergeDocumentsInput): Promise<MergeDocumentsResult> {
    await mkdir(this.baseDir, { recursive: true })
    return mergeDocumentsImpl(input, this.baseDir)
  }

  private renderDocument(input: WriteDocumentInput, now: string): string {
    const type = input.type ? `\nType: ${input.type}` : ''
    const tags = input.tags?.length ? `\nTags: ${input.tags.join(', ')}` : ''
    const body = input.content.endsWith('\n') ? input.content : `${input.content}\n`

    return `# ${input.title}\n\nCreated: ${now}${type}${tags}\n\n${body}`
  }

  private async upsertIndex(result: WriteDocumentResult): Promise<void> {
    const indexPath = path.join(this.baseDir, INDEX_FILE_NAME)
    const relativeDocPath = path.relative(process.cwd(), result.filePath)
    const row = `| ${result.id} | ${escapeMdCell(result.title)} | ${relativeDocPath} | ${result.updatedAt} |`

    let lines: string[]
    try {
      const existing = await readFile(indexPath, 'utf8')
      lines = existing.split('\n')
    } catch {
      lines = [
        '# TinySQL Document Table',
        '',
        '| id | title | path | updated_at |',
        '| --- | --- | --- | --- |',
      ]
    }

    const rowPrefix = `| ${result.id} |`
    const rowIndex = lines.findIndex(line => line.startsWith(rowPrefix))
    if (rowIndex >= 0) {
      lines[rowIndex] = row
    } else {
      lines.push(row)
    }

    await writeFile(indexPath, `${lines.join('\n').replace(/\n*$/u, '')}\n`, 'utf8')
  }
}

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document'
}

function escapeMdCell(value: string): string {
  return value.replace(/\|/g, '\\|')
}
