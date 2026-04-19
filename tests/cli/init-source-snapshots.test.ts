import { describe, expect, it } from 'vitest'
import {
  INIT_SOURCE_SNAPSHOT_MAX_CHARS,
  appendFrozenSourceSnapshots,
  buildFrozenSourceSnapshotDoc,
  isInitReadmeHomePath,
} from '../../src/cli/init-source-snapshots'

describe('init-source-snapshots', () => {
  it('Given many autogen-only docs and several source files, then append adds frozen originals per file', () => {
    const autogen = Array.from({ length: 8 }, (_, i) => ({
      title: `Topic ${i}`,
      content: `# Topic ${i}\n\nBody.`,
      isOriginal: false as const,
    }))
    const sourceFiles = {
      'README.md': '# Home\n',
      'AGENTS.md': '# Agents\n\nRules.',
      'CLAUDE.md': '# Claude\n\nHints.',
    }
    const merged = appendFrozenSourceSnapshots(autogen, sourceFiles, 'mybase')
    expect(merged).toHaveLength(10)
    const originals = merged.filter(d => d.isOriginal)
    expect(originals).toHaveLength(2)
    expect(originals.map(d => d.title).sort()).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(originals.every(d => d.content.includes('frozen snapshot'))).toBe(true)
  })

  it('Given an original shard already exists for a file title, then append does not duplicate that file', () => {
    const shard = buildFrozenSourceSnapshotDoc(
      'AGENTS.md',
      '# Agents\n',
      'base',
      'split-from-single'
    )
    const docs = [
      { title: 'Overview', content: 'x', isOriginal: false },
      shard,
    ]
    const merged = appendFrozenSourceSnapshots(docs, { 'AGENTS.md': '# New body', 'NOTE.md': 'N' }, 'base')
    const agents = merged.filter(d => d.title === 'AGENTS.md')
    expect(agents).toHaveLength(1)
    expect(merged.some(d => d.title === 'NOTE.md')).toBe(true)
  })

  it('Given README path, then isInitReadmeHomePath is true only for readme.md basename', () => {
    expect(isInitReadmeHomePath('README.md')).toBe(true)
    expect(isInitReadmeHomePath('docs/README.md')).toBe(true)
    expect(isInitReadmeHomePath('AGENTS.md')).toBe(false)
  })

  it('Given oversized file body, then snapshot content is clipped with truncation marker', () => {
    const huge = 'x'.repeat(INIT_SOURCE_SNAPSHOT_MAX_CHARS + 500)
    const doc = buildFrozenSourceSnapshotDoc('big.txt', huge, 'b', 'collected-on-init')
    expect(doc.content).toContain('…(truncated during init split)…')
    expect(doc.content.length).toBeLessThan(huge.length + 500)
  })
})
