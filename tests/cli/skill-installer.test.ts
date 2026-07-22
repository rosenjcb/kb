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
} from '@kb/client/cli/skill-installer.js'
import { loadSkill } from '@kb/core/skills/loader.js'

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
  it('[TC-376] Given no existing skill files, then installs all agents and returns installed actions', async () => {
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

  it('[TC-377] Given already-installed skill with matching hash, then action is skipped', async () => {
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

  it('[TC-378] Given stale skill hash, then action is updated', async () => {
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

  it('[TC-379] Given ~/.claude/CLAUDE.md exists without KB section, then injects blurb', async () => {
    const claudeMd = path.join(fakeHome, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, '# Agent Instructions\n\nSome rules.\n', 'utf8')

    const results = await installSkillIntoProject()
    const result = results.find(r => r.file === '~/.claude/CLAUDE.md')
    expect(result?.action).toBe('injected')

    const content = await readFile(claudeMd, 'utf8')
    expect(content).toContain('# KB dev workflow')
    expect(content).toContain('kb_query')
  })

  it('[TC-380] Given ~/.claude/CLAUDE.md already has KB section, then action is already-present', async () => {
    const claudeMd = path.join(fakeHome, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, '# Agent Instructions\n\n# KB dev workflow\n\nAlready here.\n', 'utf8')

    const results = await installSkillIntoProject()
    const result = results.find(r => r.file === '~/.claude/CLAUDE.md')
    expect(result?.action).toBe('already-present')
  })

  it('[TC-381] Given ~/.codex/AGENTS.md exists without KB section, then injects blurb', async () => {
    const agentsMd = path.join(fakeHome, '.codex', 'AGENTS.md')
    await mkdir(path.dirname(agentsMd), { recursive: true })
    await writeFile(agentsMd, '# Agents\n\nRules here.\n', 'utf8')

    const results = await installSkillIntoProject()
    const result = results.find(r => r.file === '~/.codex/AGENTS.md')
    expect(result?.action).toBe('injected')
  })

  it('[TC-382] Given neither profile MD exists, then creates ~/.claude/CLAUDE.md', async () => {
    const results = await installSkillIntoProject()
    const created = results.find(r => r.action === 'created')
    expect(created?.file).toBe('~/.claude/CLAUDE.md')

    const content = await readFile(path.join(fakeHome, '.claude', 'CLAUDE.md'), 'utf8')
    expect(content).toContain('# KB dev workflow')
  })

  it('[TC-383] Given both profile MDs exist, then only injects into whichever lacks the section', async () => {
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
  it('[TC-384] shows installed skill files and injected profile entries', () => {
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

  it('[TC-385] shows skipped skill files as up-to-date', () => {
    const report = formatSkillInstallReport(
      [{ agent: 'claude', action: 'skipped' }],
      [{ file: '~/.claude/CLAUDE.md', action: 'skipped' }]
    )
    expect(report).toContain('up-to-date')
    expect(report).toContain('skipped')
  })

  it('[TC-407] includes MCP sync section when mcp results provided', () => {
    const report = formatSkillInstallReport(
      [{ skill: 'kb:dev-workflow', agent: 'claude', action: 'skipped' }],
      [{ file: '~/.claude/CLAUDE.md', action: 'already-present' }],
      undefined,
      [{ agent: 'cursor', action: 'installed', url: 'http://localhost:38117/mcp' }]
    )
    expect(report).toContain('MCP client configs')
    expect(report).toContain('[cursor]')
    expect(report).toContain('http://localhost:38117/mcp')
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

  it('[TC-386] Given installed skill files, then removes them and reports removed', async () => {
    const skillDir = path.join(fakeHome, '.claude', 'skills', KB_DEV_WORKFLOW_SKILL_DIR)
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), '<!-- kb-skill-hash: abc -->\ncontent', 'utf8')

    const results = await uninstallSkills()
    const claude = results.find(r => r.target === 'claude')
    expect(claude?.action).toBe('removed')
  })

  it('[TC-387] Given no skill files, then action is not-found', async () => {
    const results = await uninstallSkills()
    expect(results.every(r => r.action === 'not-found')).toBe(true)
  })

  it('[TC-388] Given profile MD with injected section, then removes the section', async () => {
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

  it('[TC-389] Given profile MD without KB section, then action is not-found', async () => {
    const claudeMd = path.join(fakeHome, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, '# Agent Instructions\n\nNo KB here.\n', 'utf8')

    const results = await uninstallSkills()
    const profile = results.find(r => r.target === '~/.claude/CLAUDE.md')
    expect(profile?.action).toBe('not-found')
  })
})

describe('formatSkillUninstallReport', () => {
  it('[TC-390] Given removed results, then formats readable output', () => {
    const report = formatSkillUninstallReport([
      { target: 'claude', action: 'removed' },
      { target: '~/.claude/CLAUDE.md', action: 'removed' },
      { target: 'cursor', action: 'not-found' },
    ])
    expect(report).toContain('✓ Removed KB skill from claude')
    expect(report).toContain('✓ Removed KB skill from ~/.claude/CLAUDE.md')
    expect(report).not.toContain('cursor')
  })

  it('[TC-408] includes MCP removals when mcp results provided', () => {
    const report = formatSkillUninstallReport(
      [{ target: 'claude', action: 'removed' }],
      undefined,
      [
        { agent: 'cursor', action: 'removed' },
        { agent: 'claude', action: 'not-found' },
      ]
    )
    expect(report).toContain('✓ Removed KB MCP entry from cursor')
    expect(report).not.toContain('not-found')
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

  it('[TC-391] Given no provider config dirs, then Claude and antigravity-cli are still installed (ensureConfigDir) and others are not-installed', async () => {
    const results = await installHooks()
    expect(results.find(r => r.provider === 'claude')?.action).toBe('installed')
    expect(results.find(r => r.provider === 'antigravity-cli')?.action).toBe('installed')
    expect(
      results.filter(r => r.provider !== 'claude' && r.provider !== 'antigravity-cli').every(r => r.action === 'not-installed')
    ).toBe(true)
  })

  it('[TC-392] Given Claude config dir exists with no settings.json, then creates settings.json with hook', async () => {
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })

    const results = await installHooks()
    const claude = results.find(r => r.provider === 'claude')
    expect(claude?.action).toBe('installed')

    const raw = await readFile(path.join(fakeHome, '.claude', 'settings.json'), 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.hooks?.PreToolUse).toBeDefined()
    const group = settings.hooks.PreToolUse.find(
      (g: { matcher: string }) => g.matcher === 'Bash|Grep|Glob'
    )
    expect(group).toBeDefined()
    expect(group.hooks[0].command).toContain('kb-reminder.sh')
  })

  it('[TC-393] Given hook already installed at current path, then action is skipped', async () => {
    const scriptPath = path.join(fakeHome, '.kb', 'hooks', 'kb-reminder.sh')
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash|Grep|Glob', hooks: [{ type: 'command', command: scriptPath }] },
          ],
        },
      }),
      'utf8'
    )

    const results = await installHooks()
    const claude = results.find(r => r.provider === 'claude')
    expect(claude?.action).toBe('skipped')
  })

  it('[TC-394] Given hook installed at stale path, then updates to current path', async () => {
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
    const group = settings.hooks.PreToolUse.find(
      (g: { matcher: string }) => g.matcher === 'Bash|Grep|Glob'
    )
    expect(group).toBeDefined()
    expect(group.hooks.some((h: { command: string }) => h.command === oldPath)).toBe(false)
    expect(group.hooks.some((h: { command: string }) => h.command.endsWith('kb-reminder.sh'))).toBe(true)
  })

  it('[TC-395] Given settings.json with existing hooks, then merges without clobbering', async () => {
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
    const other = settings.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === 'Bash')
    const kb = settings.hooks.PreToolUse.find(
      (g: { matcher: string }) => g.matcher === 'Bash|Grep|Glob'
    )
    expect(other.hooks.some((h: { command: string }) => h.command === '/other/hook.sh')).toBe(true)
    expect(kb.hooks.some((h: { command: string }) => h.command.endsWith('kb-reminder.sh'))).toBe(true)
  })

  it('[TC-396] Given Gemini config dir exists, then installs BeforeTool hook in settings.json', async () => {
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

  it('[TC-397] Given Codex config dir exists, then installs hook in hooks.json', async () => {
    await mkdir(path.join(fakeHome, '.codex'), { recursive: true })

    const results = await installHooks()
    const codex = results.find(r => r.provider === 'codex')
    expect(codex?.action).toBe('installed')

    const raw = await readFile(path.join(fakeHome, '.codex', 'hooks.json'), 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.hooks?.PreToolUse).toBeDefined()
  })

  /** Run the installed hook script with an isolated throttle-state dir. */
  async function runHook(
    scriptPath: string,
    input: Record<string, unknown>,
    env: Record<string, string> = {}
  ): Promise<string> {
    const { spawnSync } = await import('node:child_process')
    const stateDir = path.join(tempDir, `hook-state-${Math.random().toString(36).slice(2)}`)
    const ran = spawnSync(scriptPath, [], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, KB_HOOK_STATE_DIR: stateDir, ...env },
    })
    expect(ran.status).toBe(0)
    return (ran.stdout ?? '').trim()
  }

  async function installedHookScript(): Promise<string> {
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await installHooks()
    return path.join(fakeHome, '.kb', 'hooks', 'kb-reminder.sh')
  }

  it('[TC-398] Writes executable hook script that emits Claude JSON additionalContext', async () => {
    const scriptPath = await installedHookScript()
    const content = await readFile(scriptPath, 'utf8')
    expect(content).toContain('#!/usr/bin/env bash')
    expect(content).toContain('additionalContext')
    expect(content).toContain('hookSpecificOutput')
    expect(content).toContain('kb_query')

    const stdout = await runHook(scriptPath, {
      tool_name: 'Bash',
      tool_input: { command: 'grep -r foo .' },
    })
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('kb MCP')
  })

  it('[TC-399] Given Grep tool input, hook emits additionalContext JSON', async () => {
    const scriptPath = await installedHookScript()
    const stdout = await runHook(scriptPath, { tool_name: 'Grep', tool_input: { pattern: 'foo' } })
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain('kb_query')
  })

  it('[TC-400] Given Read tool, hook stays silent', async () => {
    const scriptPath = await installedHookScript()
    const stdout = await runHook(scriptPath, {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
    })
    expect(stdout).toBe('')
  })

  it('[TC-442] Given non-search Bash commands, hook stays silent', async () => {
    const scriptPath = await installedHookScript()
    const commands = [
      'git status',
      'gcloud run deploy api --region us-east1',
      'tsc --noEmit',
      'gh pr view 42',
      'pnpm run biome check .',
      'npm run find-deps', // "find" inside a script name is not a search
      'sed -i s/a/b/ src/foo.ts', // transforms are not repo search anymore
      "awk NF file.txt",
    ]
    for (const command of commands) {
      const stdout = await runHook(scriptPath, { tool_name: 'Bash', tool_input: { command } })
      expect(stdout, command).toBe('')
    }
  })

  it('[TC-443] Given grep only filtering another command output, hook stays silent', async () => {
    const scriptPath = await installedHookScript()
    const commands = ['tsc --noEmit | grep error', 'git log --oneline | grep fix', 'ps aux | rg node']
    for (const command of commands) {
      const stdout = await runHook(scriptPath, { tool_name: 'Bash', tool_input: { command } })
      expect(stdout, command).toBe('')
    }
  })

  it('[TC-444] Given repo-search commands in command position, hook fires', async () => {
    const scriptPath = await installedHookScript()
    const commands = [
      'grep -r foo src/',
      'rg pattern .',
      'find . -name "*.ts"',
      'git grep TODO',
      'kb query "how does auth work"',
      'cd packages && grep -r foo .',
      'find . -name "*.ts" | xargs grep foo',
    ]
    for (const command of commands) {
      const stdout = await runHook(scriptPath, { tool_name: 'Bash', tool_input: { command } })
      expect(stdout, command).toContain('kb_query')
    }
  })

  it('[TC-445] Given a repeat search in the same session window, hook reminds only once', async () => {
    const scriptPath = await installedHookScript()
    const stateDir = path.join(tempDir, 'hook-state-shared')
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'grep -r foo .' },
      session_id: 'session-1',
    }
    const { spawnSync } = await import('node:child_process')
    const run = () =>
      spawnSync(scriptPath, [], {
        input: JSON.stringify(input),
        encoding: 'utf8',
        env: { ...process.env, KB_HOOK_STATE_DIR: stateDir },
      })
    expect((run().stdout ?? '').trim()).toContain('kb_query')
    expect((run().stdout ?? '').trim()).toBe('')

    // A different session gets its own reminder.
    const other = spawnSync(scriptPath, [], {
      input: JSON.stringify({ ...input, session_id: 'session-2' }),
      encoding: 'utf8',
      env: { ...process.env, KB_HOOK_STATE_DIR: stateDir },
    })
    expect((other.stdout ?? '').trim()).toContain('kb_query')
  })

  it('[TC-446] Given KB_HOOK_REMINDER=false, hook stays silent even for searches', async () => {
    const scriptPath = await installedHookScript()
    const stdout = await runHook(
      scriptPath,
      { tool_name: 'Grep', tool_input: { pattern: 'foo' } },
      { KB_HOOK_REMINDER: 'false' }
    )
    expect(stdout).toBe('')
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

  it('[TC-401] Given hook present in settings.json, then removes it', async () => {
    const scriptPath = path.join(fakeHome, '.kb', 'hooks', 'kb-reminder.sh')
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash|Grep|Glob', hooks: [{ type: 'command', command: scriptPath }] },
          ],
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
    const group = groups.find(g => g.matcher === 'Bash|Grep|Glob')
    expect(group).toBeUndefined()
  })

  it('[TC-402] Given no settings.json, then action is not-installed', async () => {
    const results = await uninstallHooks()
    expect(results.every(r => r.action === 'not-installed')).toBe(true)
  })

  it('[TC-403] Given settings.json without KB hook, then action is not-installed', async () => {
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json')
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({ agentPushNotifEnabled: true }), 'utf8')

    const results = await uninstallHooks()
    const claude = results.find(r => r.provider === 'claude')
    expect(claude?.action).toBe('not-installed')
  })

  it('[TC-404] Given hook plus other hooks in same matcher group, then only removes kb hook', async () => {
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
  it('[TC-405] includes Agent hooks section when hook results provided', () => {
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

  it('[TC-406] omits Agent hooks section when hook results not provided', () => {
    const report = formatSkillInstallReport([], [])
    expect(report).not.toContain('Agent hooks')
  })
})
