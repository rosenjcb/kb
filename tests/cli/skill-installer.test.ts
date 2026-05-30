import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatSkillInstallReport,
  formatSkillUninstallReport,
  installHooks,
  installSkillIntoProject,
  installSkillsGlobally,
  uninstallHooks,
  uninstallSkills,
} from '../../src/cli/skill-installer'
import { loadSkill } from '../../src/skills/loader'

const KB_DEV_WORKFLOW_SKILL = loadSkill('kb:dev-workflow')
const KB_DEV_WORKFLOW_SKILL_DIR = 'kb:dev-workflow'

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
    const skillDir = path.join(fakeHome, '.claude', 'skills', KB_DEV_WORKFLOW_SKILL_DIR)
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
    const skillDir = path.join(fakeHome, '.claude', 'skills', KB_DEV_WORKFLOW_SKILL_DIR)
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
    const skillDir = path.join(fakeHome, '.claude', 'skills', KB_DEV_WORKFLOW_SKILL_DIR)
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

describe('installHooks', () => {
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

  it('Given no provider config dirs, then all results are not-installed', async () => {
    const results = await installHooks()
    expect(results.every(r => r.action === 'not-installed')).toBe(true)
  })

  it('Given Claude config dir exists with no settings.json, then creates settings.json with hook', async () => {
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })

    const results = await installHooks()
    const claude = results.find(r => r.provider === 'claude')
    expect(claude?.action).toBe('installed')

    const raw = await readFile(path.join(fakeHome, '.claude', 'settings.json'), 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.hooks?.PreToolUse).toBeDefined()
    const group = settings.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === 'Bash')
    expect(group).toBeDefined()
    expect(group.hooks[0].command).toContain('kb-reminder.sh')
  })

  it('Given hook already installed at current path, then action is skipped', async () => {
    const scriptPath = path.join(fakeHome, '.kb', 'hooks', 'kb-reminder.sh')
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: scriptPath }] }],
        },
      }),
      'utf8'
    )

    const results = await installHooks()
    const claude = results.find(r => r.provider === 'claude')
    expect(claude?.action).toBe('skipped')
  })

  it('Given hook installed at stale path, then updates to current path', async () => {
    const oldPath = '/old/location/kb-reminder.sh'
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: oldPath }] }],
        },
      }),
      'utf8'
    )

    const results = await installHooks()
    const claude = results.find(r => r.provider === 'claude')
    expect(claude?.action).toBe('updated')

    const raw = await readFile(settingsPath, 'utf8')
    const settings = JSON.parse(raw)
    const group = settings.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === 'Bash')
    expect(group.hooks.some((h: { command: string }) => h.command === oldPath)).toBe(false)
    expect(group.hooks.some((h: { command: string }) => h.command.endsWith('kb-reminder.sh'))).toBe(true)
  })

  it('Given settings.json with existing hooks, then merges without clobbering', async () => {
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({
        agentPushNotifEnabled: true,
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/hook.sh' }] }],
        },
      }),
      'utf8'
    )

    await installHooks()

    const raw = await readFile(settingsPath, 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.agentPushNotifEnabled).toBe(true)
    const group = settings.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === 'Bash')
    expect(group.hooks.length).toBe(2)
    expect(group.hooks.some((h: { command: string }) => h.command === '/other/hook.sh')).toBe(true)
  })

  it('Given Gemini config dir exists, then installs BeforeTool hook in settings.json', async () => {
    await mkdir(path.join(fakeHome, '.gemini'), { recursive: true })

    const results = await installHooks()
    const gemini = results.find(r => r.provider === 'gemini')
    expect(gemini?.action).toBe('installed')

    const raw = await readFile(path.join(fakeHome, '.gemini', 'settings.json'), 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.hooks?.BeforeTool).toBeDefined()
    const group = settings.hooks.BeforeTool.find(
      (g: { matcher: string }) => g.matcher === 'run_shell_command'
    )
    expect(group).toBeDefined()
  })

  it('Given Codex config dir exists, then installs hook in hooks.json', async () => {
    await mkdir(path.join(fakeHome, '.codex'), { recursive: true })

    const results = await installHooks()
    const codex = results.find(r => r.provider === 'codex')
    expect(codex?.action).toBe('installed')

    const raw = await readFile(path.join(fakeHome, '.codex', 'hooks.json'), 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.hooks?.PreToolUse).toBeDefined()
  })

  it('Writes executable hook script to ~/.kb/hooks/kb-reminder.sh', async () => {
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await installHooks()

    const scriptPath = path.join(fakeHome, '.kb', 'hooks', 'kb-reminder.sh')
    const content = await readFile(scriptPath, 'utf8')
    expect(content).toContain('#!/bin/bash')
    expect(content).toContain('grep')
    expect(content).toContain('kb query')
  })
})

describe('uninstallHooks', () => {
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

  it('Given hook present in settings.json, then removes it', async () => {
    const scriptPath = path.join(fakeHome, '.kb', 'hooks', 'kb-reminder.sh')
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: scriptPath }] }],
        },
      }),
      'utf8'
    )

    const results = await uninstallHooks()
    const claude = results.find(r => r.provider === 'claude')
    expect(claude?.action).toBe('updated')

    const raw = await readFile(settingsPath, 'utf8')
    const settings = JSON.parse(raw)
    const groups: Array<{ matcher: string; hooks: unknown[] }> = settings.hooks?.PreToolUse ?? []
    const group = groups.find(g => g.matcher === 'Bash')
    expect(group).toBeUndefined()
  })

  it('Given no settings.json, then action is not-installed', async () => {
    const results = await uninstallHooks()
    expect(results.every(r => r.action === 'not-installed')).toBe(true)
  })

  it('Given settings.json without KB hook, then action is not-installed', async () => {
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({ agentPushNotifEnabled: true }), 'utf8')

    const results = await uninstallHooks()
    const claude = results.find(r => r.provider === 'claude')
    expect(claude?.action).toBe('not-installed')
  })

  it('Given hook plus other hooks in same matcher group, then only removes kb hook', async () => {
    const scriptPath = path.join(fakeHome, '.kb', 'hooks', 'kb-reminder.sh')
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: '/other/hook.sh' },
                { type: 'command', command: scriptPath },
              ],
            },
          ],
        },
      }),
      'utf8'
    )

    await uninstallHooks()

    const raw = await readFile(settingsPath, 'utf8')
    const settings = JSON.parse(raw)
    const group = settings.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === 'Bash')
    expect(group).toBeDefined()
    expect(group.hooks.length).toBe(1)
    expect(group.hooks[0].command).toBe('/other/hook.sh')
  })
})

describe('formatSkillInstallReport with hooks', () => {
  it('includes Agent hooks section when hook results provided', () => {
    const report = formatSkillInstallReport(
      [],
      [],
      [
        { provider: 'claude', action: 'installed' },
        { provider: 'gemini', action: 'not-installed' },
      ]
    )
    expect(report).toContain('Agent hooks')
    expect(report).toContain('✓ installed  claude')
    expect(report).toContain('skipped    gemini')
  })

  it('omits Agent hooks section when hook results not provided', () => {
    const report = formatSkillInstallReport([], [])
    expect(report).not.toContain('Agent hooks')
  })
})
