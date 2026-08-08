import { describe, expect, it } from 'vitest'
import { formatFactUri, sourceRefToPath } from '@kb/core/core/fact-uri.js'

describe('formatFactUri', () => {
  it('[TC-61] strips fact- prefix before scheme so sources line does not repeat fact', () => {
    expect(formatFactUri('fact-91cf8cf47a435545')).toBe('fact://91cf8cf47a435545')
  })

  it('[TC-62] passes through ids that are not fact-prefixed', () => {
    expect(formatFactUri('doc-abc')).toBe('doc-abc')
  })
})

describe('sourceRefToPath', () => {
  it('[TC-63] resolves a code ast: ref to its physical file + symbol', () => {
    expect(sourceRefToPath('ast:src/ast/langs/typescript.ts@parseModule')).toEqual({
      path: 'src/ast/langs/typescript.ts',
      symbol: 'parseModule',
    })
  })

  it('[TC-64] resolves an ast: ref without a symbol', () => {
    expect(sourceRefToPath('ast:src/ast/registry.ts')).toEqual({ path: 'src/ast/registry.ts' })
  })

  it('[TC-65] drops the segment anchor from a doc ref', () => {
    expect(sourceRefToPath('docs/architecture.md#s3')).toEqual({ path: 'docs/architecture.md' })
  })

  it('[TC-66] prefixes the git repo slug for multi-repo provenance', () => {
    expect(sourceRefToPath('ast:src/index.ts@main', 'acme-web')).toEqual({
      path: 'acme-web/src/index.ts',
      symbol: 'main',
    })
  })

  it('[TC-67] returns undefined for empty or synthetic refs', () => {
    expect(sourceRefToPath(null)).toBeUndefined()
    expect(sourceRefToPath('')).toBeUndefined()
    expect(sourceRefToPath('replace:fact-123')).toBeUndefined()
    expect(sourceRefToPath('https://example.com/doc.md')).toBeUndefined()
  })

  it('[TC-68] allows colons in later path segments (skill folder names)', () => {
    expect(
      sourceRefToPath('rosenjcb-kb/skills/kb:dev-workflow/SKILL.md#s53', 'rosenjcb-kb')
    ).toEqual({ path: 'rosenjcb-kb/skills/kb:dev-workflow/SKILL.md' })
  })

  it('[TC-69] returns undefined for heritage/import hash refs (no openable path)', () => {
    // These hash the file away; surfacing them yields a bogus `edge:<sha>` filename.
    expect(sourceRefToPath('ast:edge:03c6a44145faa9aabced488433aff605faf6cbdb')).toBeUndefined()
    expect(sourceRefToPath('ast:import:03c6a44145faa9aabced488433aff605faf6cbdb')).toBeUndefined()
  })
})
