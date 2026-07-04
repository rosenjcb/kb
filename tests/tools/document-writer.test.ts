import { describe, expect, it, vi } from 'vitest'
import { type DocumentWriter, executeWriteDocumentTool } from '@kb/core/tools/document-writer.js'

describe('executeWriteDocumentTool', () => {
  it('[TC-69] Given valid write_document input, then should return the writer result', async () => {
    const writer: DocumentWriter = {
      writeDocument: vi.fn(async input => ({
        id: input.documentId ?? 'doc-1',
        title: input.title,
        filePath: '/tmp/doc-1.md',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
    }

    const result = await executeWriteDocumentTool(
      { title: 'My Doc', content: 'Body', tags: ['a', 'b'] },
      writer
    )

    expect(result.id).toBe('doc-1')
    expect(writer.writeDocument).toHaveBeenCalledTimes(1)
  })

  it('[TC-70] Given non-object tool input, then should throw validation error', async () => {
    const writer: DocumentWriter = {
      writeDocument: vi.fn(),
    }

    await expect(executeWriteDocumentTool('bad-input', writer)).rejects.toThrow(
      'write_document expects an object input'
    )
  })

  it('[TC-71] Given empty title input, then should throw validation error', async () => {
    const writer: DocumentWriter = {
      writeDocument: vi.fn(),
    }

    await expect(
      executeWriteDocumentTool({ title: '   ', content: 'Body' }, writer)
    ).rejects.toThrow('write_document: title cannot be empty')
  })

  it('[TC-72] Given non-string tags entries, then should throw validation error', async () => {
    const writer: DocumentWriter = {
      writeDocument: vi.fn(),
    }

    await expect(
      executeWriteDocumentTool({ title: 'Doc', content: 'Body', tags: ['ok', 42] }, writer)
    ).rejects.toThrow('write_document: tags must be an array of strings when provided')
  })

  it('[TC-73] Given valid document type, then should pass parsed type to writer', async () => {
    const writer: DocumentWriter = {
      writeDocument: vi.fn(async input => ({
        id: input.documentId ?? 'doc-type',
        title: input.title,
        filePath: '/tmp/doc-type.md',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
    }

    await executeWriteDocumentTool({ title: 'Howto', content: 'Body', type: 'howto' }, writer)

    expect(writer.writeDocument).toHaveBeenCalledWith(expect.objectContaining({ type: 'howto' }))
  })

  it('[TC-74] Given invalid document type, then should throw validation error', async () => {
    const writer: DocumentWriter = {
      writeDocument: vi.fn(),
    }

    await expect(
      executeWriteDocumentTool({ title: 'Doc', content: 'Body', type: 'invalid-type' }, writer)
    ).rejects.toThrow(
      'write_document: type must be one of howto, introduction, reference, decision, runbook'
    )
  })
})
