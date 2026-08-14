import { describe, expect, it } from 'vitest'
import { isOkfDocument, parseOkfDocument } from '@kb/core/core/okf.js'

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
  it('[TC-91] detects an OKF doc and parses recommended fields', () => {
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

  it('[TC-92] treats frontmatter without a type as non-OKF but still strips it', () => {
    const doc = '---\ntitle: Just metadata\n---\n\nBody text here.'
    const { isOkf, frontmatter, body } = parseOkfDocument(doc)
    expect(isOkf).toBe(false)
    expect(frontmatter).toBeNull()
    expect(body).toBe('\nBody text here.')
  })

  it('[TC-93] returns plain markdown unchanged', () => {
    const doc = '# Title\n\nSome prose.'
    const { isOkf, frontmatter, body } = parseOkfDocument(doc)
    expect(isOkf).toBe(false)
    expect(frontmatter).toBeNull()
    expect(body).toBe(doc)
  })

  it('[TC-94] does not mistake a leading thematic break / prose for frontmatter', () => {
    const doc = '---\nSome prose between rules.\n---\nMore text.'
    const { isOkf, body } = parseOkfDocument(doc)
    expect(isOkf).toBe(false)
    expect(body).toBe(doc)
  })

  it('[TC-95] accepts a comma-separated tags string', () => {
    const doc = '---\ntype: Playbook\ntitle: Deploy\ntags: ops, release\n---\nbody'
    expect(parseOkfDocument(doc).frontmatter?.tags).toEqual(['ops', 'release'])
  })

  it('[TC-96] degrades gracefully on malformed YAML', () => {
    const doc = '---\ntype: : : broken\n  bad indent\n---\nbody'
    const { isOkf, body } = parseOkfDocument(doc)
    expect(isOkf).toBe(false)
    expect(body).toBe(doc)
  })
})

describe('isOkfDocument', () => {
  it('[TC-97] is true only for frontmatter carrying a non-empty type', () => {
    expect(isOkfDocument(OKF_DOC)).toBe(true)
    expect(isOkfDocument('# Plain\n\ntext')).toBe(false)
  })
})
