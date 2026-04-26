import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatSkillInstallReport,
  installSkillIntoProject,
  installSkillsGlobally,
} from '../../src/cli/skill-installer'
import { KB_DEV_WORKFLOW_SKILL } from '../../src/skills/kb-dev-workflow'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-skill-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('installSkillsGlobally', () => {
  it('Given no existing skill files, then installs all agents and returns installed actions', async () => {
    // Override HOME so we don't touch the real ~/.claude etc.
    const fakeHome = path.join(tempDir, 'home')
    await mkdir(fakeHome)
    const origHome = os.homedir()
    process.env.HOME = fakeHome

    try {
      const results = await installSkillsGlobally()
      expect(results.length).toBeGreaterThan(0)
      expect(results.every(r => r.action === 'installed' || r.action === 'skipped')).toBe(true)
    } finally {
      process.env.HOME = origHome
    }
  })

  it('Given already-installed skill with matching hash, then action is skipped', async () => {
    const fakeHome = path.join(tempDir, 'home')
    const skillDir = path.join(fakeHome, '.claude', 'skills', 'kb-dev-workflow')
    await mkdir(skillDir, { recursive: true })

    // Write a file with the correct hash header
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(KB_DEV_WORKFLOW_SKILL).digest('hex').slice(0, 12)
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `<!-- kb-skill-hash: ${hash} -->\n${KB_DEV_WORKFLOW_SKILL}`,
      'utf8'
    )

    const origHome = os.homedir()
    process.env.HOME = fakeHome
    try {
      const results = await installSkillsGlobally()
      const claude = results.find(r => r.agent === 'claude')
      expect(claude?.action).toBe('skipped')
    } finally {
      process.env.HOME = origHome
    }
  })

  it('Given stale skill hash, then action is updated', async () => {
    const fakeHome = path.join(tempDir, 'home')
    const skillDir = path.join(fakeHome, '.claude', 'skills', 'kb-dev-workflow')
    await mkdir(skillDir, { recursive: true })
    // Write with a wrong hash
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '<!-- kb-skill-hash: 000000000000 -->\nold content',
      'utf8'
    )

    const origHome = os.homedir()
    process.env.HOME = fakeHome
    try {
      const results = await installSkillsGlobally()
      const claude = results.find(r => r.agent === 'claude')
      expect(claude?.action).toBe('updated')
    } finally {
      process.env.HOME = origHome
    }
  })
})

describe('installSkillIntoProject', () => {
  it('Given CLAUDE.md exists without KB section, then injects blurb', async () => {
    await writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      '# Project Instructions\n\nSome rules.\n',
      'utf8'
    )

    const results = await installSkillIntoProject(tempDir)
    const claude = results.find(r => r.file === 'CLAUDE.md')
    expect(claude?.action).toBe('injected')

    const content = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8')
    expect(content).toContain('## KB (knowledge base)')
    expect(content).toContain('kb query')
  })

  it('Given CLAUDE.md already has KB section, then action is already-present', async () => {
    await writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      '# Project\n\n## KB (knowledge base)\n\nAlready here.\n',
      'utf8'
    )

    const results = await installSkillIntoProject(tempDir)
    const claude = results.find(r => r.file === 'CLAUDE.md')
    expect(claude?.action).toBe('already-present')
  })

  it('Given AGENTS.md exists without KB section, then injects blurb', async () => {
    await writeFile(path.join(tempDir, 'AGENTS.md'), '# Agents\n\nRules here.\n', 'utf8')

    const results = await installSkillIntoProject(tempDir)
    const agents = results.find(r => r.file === 'AGENTS.md')
    expect(agents?.action).toBe('injected')
  })

  it('Given neither CLAUDE.md nor AGENTS.md exists, then creates AGENTS.md', async () => {
    const results = await installSkillIntoProject(tempDir)
    const created = results.find(r => r.action === 'created')
    expect(created?.file).toBe('AGENTS.md')

    const content = await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8')
    expect(content).toContain('## KB (knowledge base)')
  })

  it('Given both CLAUDE.md and AGENTS.md exist, then only injects into whichever lacks the section', async () => {
    await writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      '# Project\n\n## KB (knowledge base)\n\nPresent.\n',
      'utf8'
    )
    await writeFile(path.join(tempDir, 'AGENTS.md'), '# Agents\n\nMissing.\n', 'utf8')

    const results = await installSkillIntoProject(tempDir)
    expect(results.find(r => r.file === 'CLAUDE.md')?.action).toBe('already-present')
    expect(results.find(r => r.file === 'AGENTS.md')?.action).toBe('injected')
  })
})

describe('formatSkillInstallReport', () => {
  it('Given injected and already-present results, then formats readable output', () => {
    const report = formatSkillInstallReport([
      { file: 'CLAUDE.md', action: 'injected' },
      { file: 'AGENTS.md', action: 'already-present' },
    ])
    expect(report).toContain('✓ Injected KB skill reference into CLAUDE.md')
    expect(report).toContain('• AGENTS.md already has KB skill section')
  })

  it('Given only skipped results, then returns empty string', () => {
    const report = formatSkillInstallReport([
      { file: 'CLAUDE.md', action: 'skipped' },
      { file: 'AGENTS.md', action: 'skipped' },
    ])
    expect(report).toBe('')
  })
})
