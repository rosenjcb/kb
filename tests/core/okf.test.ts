import { describe, expect, it } from 'vitest'
import {
  isOkfDocument,
  okfFrontmatterSegments,
  parseOkfDocument,
} from '../../src/core/okf'

const OKF_DOC = `---
type: Subsystem
title: TUI Renderer
description: Drives the Ink-based interactive session loop.
tags: [tui, rendering]
resource: ./src/tui
timestamp: 2026-06-20T00:00:00Z
---

# TUI Renderer

The renderer owns the frame loop.
`

describe('parseOkfDocument', () => {
  it('detects an OKF doc and parses recommended fields', () => {
    const { isOkf, frontmatter, body } = parseOkfDocument(OKF_DOC)
    expect(isOkf).toBe(true)
    expect(frontmatter?.type).toBe('Subsystem')
    expect(frontmatter?.title).toBe('TUI Renderer')
    expect(frontmatter?.description).toBe('Drives the Ink-based interactive session loop.')
    expect(frontmatter?.tags).toEqual(['tui', 'rendering'])
    expect(frontmatter?.resource).toBe('./src/tui')
    expect(body.startsWith('\n# TUI Renderer')).toBe(true)
    // Frontmatter is removed from the body.
    expect(body).not.toContain('type: Subsystem')
  })

  it('treats frontmatter without a type as non-OKF but still strips it', () => {
    const doc = '---\ntitle: Just metadata\n---\n\nBody text here.'
    const { isOkf, frontmatter, body } = parseOkfDocument(doc)
    expect(isOkf).toBe(false)
    expect(frontmatter).toBeNull()
    expect(body).toBe('\nBody text here.')
  })

  it('returns plain markdown unchanged', () => {
    const doc = '# Title\n\nSome prose.'
    const { isOkf, frontmatter, body } = parseOkfDocument(doc)
    expect(isOkf).toBe(false)
    expect(frontmatter).toBeNull()
    expect(body).toBe(doc)
  })

  it('does not mistake a leading thematic break / prose for frontmatter', () => {
    const doc = '---\nSome prose between rules.\n---\nMore text.'
    const { isOkf, body } = parseOkfDocument(doc)
    expect(isOkf).toBe(false)
    expect(body).toBe(doc)
  })

  it('accepts a comma-separated tags string', () => {
    const doc = '---\ntype: Playbook\ntitle: Deploy\ntags: ops, release\n---\nbody'
    expect(parseOkfDocument(doc).frontmatter?.tags).toEqual(['ops', 'release'])
  })

  it('degrades gracefully on malformed YAML', () => {
    const doc = '---\ntype: : : broken\n  bad indent\n---\nbody'
    const { isOkf, body } = parseOkfDocument(doc)
    expect(isOkf).toBe(false)
    expect(body).toBe(doc)
  })
})

describe('isOkfDocument', () => {
  it('is true only for frontmatter carrying a non-empty type', () => {
    expect(isOkfDocument(OKF_DOC)).toBe(true)
    expect(isOkfDocument('# Plain\n\ntext')).toBe(false)
  })
})

describe('okfFrontmatterSegments', () => {
  it('synthesizes identity, description, and tag segments', () => {
    const segs = okfFrontmatterSegments({
      type: 'Subsystem',
      title: 'TUI Renderer',
      description: 'Drives the Ink-based interactive session loop.',
      tags: ['tui', 'rendering'],
    })
    expect(segs).toContain('TUI Renderer is a Subsystem.')
    expect(segs).toContain('Drives the Ink-based interactive session loop.')
    expect(segs).toContain('TUI Renderer relates to tui, rendering.')
  })

  it('falls back when no title is present', () => {
    const segs = okfFrontmatterSegments({ type: 'Playbook' })
    expect(segs).toEqual(['This document describes a Playbook.'])
  })
})
