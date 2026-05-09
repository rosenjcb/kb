import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatSkillInstallReport,
  formatSkillUninstallReport,
  installSkillIntoProject,
  installSkillsGlobally,
  uninstallSkills,
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
  let fakeHome: string
  let origHome: string | undefined

  beforeEach(async () => {
    fakeHome = path.join(tempDir, 'home')
    await mkdir(fakeHome)
    origHome = process.env.HOME
    process.env.HOME = fakeHome
  })

  afterEach(() => {
    process.env.HOME = origHome
  })

  it('Given ~/.claude/CLAUDE.md exists without KB section, then injects blurb', async () => {
    const claudeMd = path.join(fakeHome, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, '# Agent Instructions\n\nSome rules.\n', 'utf8')

    const results = await installSkillIntoProject()
    const result = results.find(r => r.file === '~/.claude/CLAUDE.md')
    expect(result?.action).toBe('injected')

    const content = await readFile(claudeMd, 'utf8')
    expect(content).toContain('# KB dev workflow')
    expect(content).toContain('kb query')
  })

  it('Given ~/.claude/CLAUDE.md already has KB section, then action is already-present', async () => {
    const claudeMd = path.join(fakeHome, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, '# Agent Instructions\n\n# KB dev workflow\n\nAlready here.\n', 'utf8')

    const results = await installSkillIntoProject()
    const result = results.find(r => r.file === '~/.claude/CLAUDE.md')
    expect(result?.action).toBe('already-present')
  })

  it('Given ~/.codex/AGENTS.md exists without KB section, then injects blurb', async () => {
    const agentsMd = path.join(fakeHome, '.codex', 'AGENTS.md')
    await mkdir(path.dirname(agentsMd), { recursive: true })
    await writeFile(agentsMd, '# Agents\n\nRules here.\n', 'utf8')

    const results = await installSkillIntoProject()
    const result = results.find(r => r.file === '~/.codex/AGENTS.md')
    expect(result?.action).toBe('injected')
  })

  it('Given neither profile MD exists, then creates ~/.claude/CLAUDE.md', async () => {
    const results = await installSkillIntoProject()
    const created = results.find(r => r.action === 'created')
    expect(created?.file).toBe('~/.claude/CLAUDE.md')

    const content = await readFile(path.join(fakeHome, '.claude', 'CLAUDE.md'), 'utf8')
    expect(content).toContain('# KB dev workflow')
  })

  it('Given both profile MDs exist, then only injects into whichever lacks the section', async () => {
    const claudeMd = path.join(fakeHome, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, '# Agent Instructions\n\n# KB dev workflow\n\nPresent.\n', 'utf8')

    const agentsMd = path.join(fakeHome, '.codex', 'AGENTS.md')
    await mkdir(path.dirname(agentsMd), { recursive: true })
    await writeFile(agentsMd, '# Agents\n\nMissing.\n', 'utf8')

    const results = await installSkillIntoProject()
    expect(results.find(r => r.file === '~/.claude/CLAUDE.md')?.action).toBe('already-present')
    expect(results.find(r => r.file === '~/.codex/AGENTS.md')?.action).toBe('injected')
  })
})

describe('formatSkillInstallReport', () => {
  it('shows installed skill files and injected profile entries', () => {
    const report = formatSkillInstallReport(
      [
        { agent: 'claude', action: 'installed' },
        { agent: 'cursor', action: 'skipped' },
      ],
      [
        { file: '~/.claude/CLAUDE.md', action: 'injected' },
        { file: '~/.codex/AGENTS.md', action: 'already-present' },
      ]
    )
    expect(report).toContain('installed')
    expect(report).toContain('[claude]')
    expect(report).toContain('up-to-date')
    expect(report).toContain('[cursor]')
    expect(report).toContain('injected')
    expect(report).toContain('~/.claude/CLAUDE.md')
    expect(report).toContain('up-to-date')
    expect(report).toContain('~/.codex/AGENTS.md')
  })

  it('shows skipped skill files as up-to-date', () => {
    const report = formatSkillInstallReport(
      [{ agent: 'claude', action: 'skipped' }],
      [{ file: '~/.claude/CLAUDE.md', action: 'skipped' }]
    )
    expect(report).toContain('up-to-date')
    expect(report).toContain('skipped')
  })
})

describe('uninstallSkills', () => {
  let fakeHome: string
  let origHome: string | undefined

  beforeEach(async () => {
    fakeHome = path.join(tempDir, 'home')
    await mkdir(fakeHome)
    origHome = process.env.HOME
    process.env.HOME = fakeHome
  })

  afterEach(() => {
    process.env.HOME = origHome
  })

  it('Given installed skill files, then removes them and reports removed', async () => {
    const skillDir = path.join(fakeHome, '.claude', 'skills', 'kb-dev-workflow')
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), '<!-- kb-skill-hash: abc -->\ncontent', 'utf8')

    const results = await uninstallSkills()
    const claude = results.find(r => r.target === 'claude')
    expect(claude?.action).toBe('removed')
  })

  it('Given no skill files, then action is not-found', async () => {
    const results = await uninstallSkills()
    expect(results.every(r => r.action === 'not-found')).toBe(true)
  })

  it('Given profile MD with injected section, then removes the section', async () => {
    const claudeMd = path.join(fakeHome, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(
      claudeMd,
      '# Agent Instructions\n\nSome rules.\n\n# KB dev workflow (agent skill)\n\nContent here.\n',
      'utf8'
    )

    const results = await uninstallSkills()
    const profile = results.find(r => r.target === '~/.claude/CLAUDE.md')
    expect(profile?.action).toBe('removed')

    const content = await readFile(claudeMd, 'utf8')
    expect(content).toContain('Some rules.')
    expect(content).not.toContain('# KB dev workflow')
  })

  it('Given profile MD without KB section, then action is not-found', async () => {
    const claudeMd = path.join(fakeHome, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, '# Agent Instructions\n\nNo KB here.\n', 'utf8')

    const results = await uninstallSkills()
    const profile = results.find(r => r.target === '~/.claude/CLAUDE.md')
    expect(profile?.action).toBe('not-found')
  })
})

describe('formatSkillUninstallReport', () => {
  it('Given removed results, then formats readable output', () => {
    const report = formatSkillUninstallReport([
      { target: 'claude', action: 'removed' },
      { target: '~/.claude/CLAUDE.md', action: 'removed' },
      { target: 'cursor', action: 'not-found' },
    ])
    expect(report).toContain('✓ Removed KB skill from claude')
    expect(report).toContain('✓ Removed KB skill from ~/.claude/CLAUDE.md')
    expect(report).not.toContain('cursor')
  })
})
