import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { loadSkill } from '@kb/core/skills/loader.js'
import {
  formatMcpSyncReport,
  type McpSyncResult,
  syncKbMcpConfigs,
  uninstallKbMcpConfigs,
} from '../api/mcp-config-sync.js'

const KB_DEV_WORKFLOW_SKILL = loadSkill('kb:dev-workflow')
const KB_DUMP_CONTEXT_SKILL = loadSkill('kb:dump-context')
const KB_EVALUATION_RUN_SKILL = loadSkill('kb:evaluation-run')

/** Strip YAML frontmatter (---...---) so the skill body can be embedded in a CLAUDE.md/AGENTS.md. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end === -1) return content
  return content.slice(end + 4).replace(/^\n/, '')
}

const KB_DEV_WORKFLOW_SKILL_BODY = stripFrontmatter(KB_DEV_WORKFLOW_SKILL)

const HASH_PREFIX = '<!-- kb-skill-hash:'

const SKILLS: Array<{ name: string; content: string }> = [
  { name: 'kb:dev-workflow', content: KB_DEV_WORKFLOW_SKILL },
  { name: 'kb:dump-context', content: KB_DUMP_CONTEXT_SKILL },
  { name: 'kb:evaluation-run', content: KB_EVALUATION_RUN_SKILL },
]

interface AgentTarget {
  name: string
  skillPath: string
  format: 'skill-md' | 'mdc'
}

function agentTargets(skillName: string): AgentTarget[] {
  const home = os.homedir()
  return [
    {
      name: 'claude',
      skillPath: path.join(home, '.claude', 'skills', skillName, 'SKILL.md'),
      format: 'skill-md',
    },
    {
      name: 'cursor',
      skillPath: path.join(home, '.cursor', 'rules', `${skillName}.mdc`),
      format: 'mdc',
    },
    {
      name: 'codex',
      skillPath: path.join(home, '.codex', 'skills', `${skillName}.md`),
      format: 'skill-md',
    },
    {
      name: 'github',
      skillPath: path.join(home, '.github', 'copilot-instructions', `${skillName}.md`),
      format: 'skill-md',
    },
    {
      name: 'antigravity',
      skillPath: path.join(home, '.gemini', 'config', 'skills', skillName, 'SKILL.md'),
      format: 'skill-md',
    },
    {
      name: 'antigravity-cli',
      skillPath: path.join(home, '.gemini', 'antigravity-cli', 'skills', skillName, 'SKILL.md'),
      format: 'skill-md',
    },
  ]
}

interface InstallTargetResult {
  agent: string
  action: 'installed' | 'updated' | 'skipped'
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function buildInstallContent(rawSkill: string, format: AgentTarget['format']): string {
  const hash = contentHash(rawSkill)
  const header = `${HASH_PREFIX} ${hash} -->\n`

  if (format === 'mdc') {
    // Cursor MDC: ensure alwaysApply front matter is present alongside the existing name/description
    const withCursorFrontmatter = rawSkill.replace(/^---\n/, '---\nalwaysApply: true\n')
    return header + withCursorFrontmatter
  }

  return header + rawSkill
}

function extractInstalledHash(content: string): string | null {
  const firstLine = content.split('\n')[0] ?? ''
  const match = firstLine.match(/<!-- kb-skill-hash: ([a-f0-9]+) -->/)
  return match ? match[1] : null
}

async function installTarget(
  target: AgentTarget,
  skillContent: string
): Promise<InstallTargetResult> {
  const expected = contentHash(skillContent)
  const installContent = buildInstallContent(skillContent, target.format)

  try {
    const existing = await readFile(target.skillPath, 'utf8')
    const installed = extractInstalledHash(existing)
    if (installed === expected) {
      return { agent: target.name, action: 'skipped' }
    }
    await writeFile(target.skillPath, installContent, 'utf8')
    return { agent: target.name, action: 'updated' }
  } catch {
    // File doesn't exist — create it
    await mkdir(path.dirname(target.skillPath), { recursive: true })
    await writeFile(target.skillPath, installContent, 'utf8')
    return { agent: target.name, action: 'installed' }
  }
}

export interface SkillInstallResult {
  skill: string
  agent: string
  action: 'installed' | 'updated' | 'skipped'
}

export async function installSkillsGlobally(): Promise<SkillInstallResult[]> {
  const all = await Promise.allSettled(
    SKILLS.flatMap(({ name, content }) =>
      agentTargets(name).map(async target => {
        const r = await installTarget(target, content)
        return { skill: name, agent: r.agent, action: r.action }
      })
    )
  )
  return all.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
}

// ─── kb skill install (profile-level blurb) ──────────────────────────────────

const PROFILE_HEADING = '# KB dev workflow'

function profileSkillTargets(): Array<{ label: string; filePath: string }> {
  const home = os.homedir()
  return [
    { label: '~/.claude/CLAUDE.md', filePath: path.join(home, '.claude', 'CLAUDE.md') },
    { label: '~/.codex/AGENTS.md', filePath: path.join(home, '.codex', 'AGENTS.md') },
  ]
}

export interface ProjectInstallResult {
  file: string
  action: 'injected' | 'already-present' | 'created' | 'skipped'
}

export async function installSkillIntoProject(): Promise<ProjectInstallResult[]> {
  const results: ProjectInstallResult[] = []

  for (const target of profileSkillTargets()) {
    let exists = false

    try {
      await stat(target.filePath)
      exists = true
    } catch {
      // doesn't exist
    }

    if (!exists) {
      results.push({ file: target.label, action: 'skipped' })
      continue
    }

    const content = await readFile(target.filePath, 'utf8')
    if (content.includes(PROFILE_HEADING)) {
      results.push({ file: target.label, action: 'already-present' })
      continue
    }

    await writeFile(target.filePath, `${content.trimEnd()}\n${KB_DEV_WORKFLOW_SKILL_BODY}`, 'utf8')
    results.push({ file: target.label, action: 'injected' })
  }

  // If no profile MDs exist yet, create ~/.claude/CLAUDE.md as the primary target
  const anyActioned = results.some(r => r.action === 'injected' || r.action === 'already-present')
  if (!anyActioned) {
    const home = os.homedir()
    const claudeMd = path.join(home, '.claude', 'CLAUDE.md')
    await mkdir(path.dirname(claudeMd), { recursive: true })
    await writeFile(claudeMd, `# Agent Instructions\n${KB_DEV_WORKFLOW_SKILL_BODY}`, 'utf8')
    results.push({ file: '~/.claude/CLAUDE.md', action: 'created' })
  }

  return results
}

export function formatSkillInstallReport(
  skillResults: SkillInstallResult[],
  profileResults: ProjectInstallResult[],
  hookResults?: HookInstallResult[],
  mcpResults?: McpSyncResult[]
): string {
  const lines: string[] = ['Skill files:']
  for (const r of skillResults) {
    const tag = r.action === 'installed' ? '✓ installed ' : r.action === 'updated' ? '↑ updated   ' : '• up-to-date'
    lines.push(`  ${tag}  ${r.skill}  [${r.agent}]`)
  }
  lines.push('', 'Profile instructions (always-on context):')
  for (const r of profileResults) {
    if (r.action === 'injected') lines.push(`  ✓ injected   ${r.file}`)
    else if (r.action === 'created') lines.push(`  ✓ created    ${r.file}`)
    else if (r.action === 'already-present') lines.push(`  • up-to-date ${r.file}`)
    else lines.push(`  - skipped    ${r.file} (not found)`)
  }
  if (hookResults) {
    lines.push('', 'Agent hooks (kb-first reminder):')
    for (const r of hookResults) {
      if (r.action === 'not-installed') lines.push(`  - skipped    ${r.provider} (not found)`)
      else if (r.action === 'installed') lines.push(`  ✓ installed  ${r.provider}`)
      else if (r.action === 'updated') lines.push(`  ↑ updated    ${r.provider}`)
      else lines.push(`  • up-to-date ${r.provider}`)
    }
  }
  if (mcpResults && mcpResults.length > 0) {
    const mcpReport = formatMcpSyncReport(mcpResults)
    if (mcpReport) lines.push('', mcpReport)
  }
  return lines.join('\n')
}

// ─── Hook installation ────────────────────────────────────────────────────────

const KB_HOOK_SCRIPT_NAME = 'kb-reminder.sh'

/** Claude PreToolUse matcher — Bash spelunking + native Grep/Glob tools. */
export const CLAUDE_KB_HOOK_MATCHER = 'Bash|Grep|Glob'

/**
 * Claude Code PreToolUse ignores plain stdout for context. Reminder must be
 * JSON with `hookSpecificOutput.additionalContext` (and optional `systemMessage`).
 * See https://code.claude.com/docs/en/hooks
 */
export const KB_HOOK_SCRIPT_CONTENT = `#!/usr/bin/env bash
# kb-reminder.sh — remind agents to use kb MCP (kb_query) before spelunking.
# Claude Code PreToolUse: plain stdout is ignored — emit JSON additionalContext.
# Docs: https://code.claude.com/docs/en/hooks
set -euo pipefail
input=$(cat || true)
payload=$(printf '%s' "$input" | python3 -c '
import json, re, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw) if raw.strip() else {}
except Exception:
    d = {}
tool = str(d.get("tool_name") or d.get("toolName") or "")
ti = d.get("tool_input") or d.get("toolInput") or {}
if not isinstance(ti, dict):
    ti = {}
cmd = str(d.get("command") or ti.get("command") or ti.get("cmd") or "")
bash_spelunk = bool(re.search(r"\\b(grep|egrep|fgrep|rg|awk|sed|find)\\b", cmd))
cli_query = bool(re.search(r"\\bkb\\s+(query|graph|docs|facts)\\b", cmd))
native_search = tool in ("Grep", "Glob")
if not (native_search or bash_spelunk or cli_query):
    sys.exit(0)
msg = (
    "Ask the kb MCP tool kb_query a direct question before Grep/Glob/find/rg or kb query. "
    "It answers agent-to-agent: a direct answer plus the source files to open. "
    "CLI/TUI is for humans; agents investigate via MCP only."
)
print(json.dumps({
    "systemMessage": msg,
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": msg,
    },
}))
' 2>/dev/null || true)
if [ -n "\${payload:-}" ]; then
  printf '%s\\n' "$payload"
fi
exit 0
`

interface HookProvider {
  name: string
  configDir: string
  settingsFile: string
  event: string
  matcher: string
  /** When true, create configDir if missing (Claude Code expects ~/.claude). */
  ensureConfigDir?: boolean
}

function hookProviders(): HookProvider[] {
  const home = os.homedir()
  return [
    {
      name: 'claude',
      configDir: path.join(home, '.claude'),
      settingsFile: path.join(home, '.claude', 'settings.json'),
      event: 'PreToolUse',
      matcher: CLAUDE_KB_HOOK_MATCHER,
      ensureConfigDir: true,
    },
    {
      name: 'gemini',
      configDir: path.join(home, '.gemini'),
      settingsFile: path.join(home, '.gemini', 'settings.json'),
      event: 'BeforeTool',
      matcher: 'run_shell_command',
    },
    {
      name: 'antigravity',
      configDir: path.join(home, '.gemini'),
      settingsFile: path.join(home, '.gemini', 'settings.json'),
      event: 'BeforeTool',
      matcher: 'run_shell_command',
    },
    {
      name: 'antigravity-cli',
      configDir: path.join(home, '.gemini', 'antigravity-cli'),
      settingsFile: path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
      event: 'BeforeTool',
      matcher: 'run_shell_command',
      ensureConfigDir: true,
    },
    {
      name: 'codex',
      configDir: path.join(home, '.codex'),
      settingsFile: path.join(home, '.codex', 'hooks.json'),
      event: 'PreToolUse',
      // Codex Bash-oriented; keep Bash-only matcher for that client.
      matcher: 'Bash',
    },
  ]
}

export interface HookInstallResult {
  provider: string
  action: 'installed' | 'updated' | 'skipped' | 'not-installed'
}

async function ensureHookScript(): Promise<string> {
  const home = os.homedir()
  const hooksDir = path.join(home, '.kb', 'hooks')
  await mkdir(hooksDir, { recursive: true })
  const scriptPath = path.join(hooksDir, KB_HOOK_SCRIPT_NAME)
  await writeFile(scriptPath, KB_HOOK_SCRIPT_CONTENT, 'utf8')
  await chmod(scriptPath, 0o755)
  return scriptPath
}

type HookEntry = { type: string; command: string }
type MatcherGroup = { matcher: string; hooks: HookEntry[] }
type HooksSection = Record<string, MatcherGroup[]>
type SettingsJson = { hooks?: HooksSection } & Record<string, unknown>

function isKbHookCommand(command: string): boolean {
  return command === KB_HOOK_SCRIPT_NAME || command.endsWith(`/${KB_HOOK_SCRIPT_NAME}`)
}

/** Find matcher group that already owns the kb reminder hook (any matcher). */
function findGroupWithKbHook(groups: MatcherGroup[]): MatcherGroup | undefined {
  return groups.find(g => g.hooks.some(h => isKbHookCommand(h.command)))
}

async function installHookForProvider(
  provider: HookProvider,
  scriptPath: string
): Promise<HookInstallResult> {
  if (provider.ensureConfigDir) {
    await mkdir(provider.configDir, { recursive: true })
  } else {
    try {
      await stat(provider.configDir)
    } catch {
      return { provider: provider.name, action: 'not-installed' }
    }
  }

  let settings: SettingsJson = {}
  try {
    const raw = await readFile(provider.settingsFile, 'utf8')
    settings = JSON.parse(raw) as SettingsJson
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  const hooksSection: HooksSection = (settings.hooks as HooksSection) ?? {}
  const eventGroups: MatcherGroup[] = [...(hooksSection[provider.event] ?? [])]
  const owned = findGroupWithKbHook(eventGroups)

  let action: HookInstallResult['action'] = 'installed'
  const hadEvent = Boolean(hooksSection[provider.event]?.length)

  if (owned) {
    const pathOk = owned.hooks.some(h => h.command === scriptPath)
    const matcherOk = owned.matcher === provider.matcher
    if (pathOk && matcherOk) {
      return { provider: provider.name, action: 'skipped' }
    }
    owned.matcher = provider.matcher
    owned.hooks = owned.hooks.map(h =>
      isKbHookCommand(h.command) ? { type: 'command', command: scriptPath } : h
    )
    action = 'updated'
  } else {
    const sameMatcher = eventGroups.find(g => g.matcher === provider.matcher)
    if (sameMatcher) {
      sameMatcher.hooks.push({ type: 'command', command: scriptPath })
      action = hadEvent ? 'updated' : 'installed'
    } else {
      eventGroups.push({
        matcher: provider.matcher,
        hooks: [{ type: 'command', command: scriptPath }],
      })
      action = hadEvent ? 'updated' : 'installed'
    }
  }

  const updated: SettingsJson = {
    ...settings,
    hooks: { ...hooksSection, [provider.event]: eventGroups },
  }

  await mkdir(path.dirname(provider.settingsFile), { recursive: true })
  await writeFile(provider.settingsFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')

  return { provider: provider.name, action }
}

export async function installHooks(): Promise<HookInstallResult[]> {
  const scriptPath = await ensureHookScript()
  return Promise.all(hookProviders().map(p => installHookForProvider(p, scriptPath)))
}

async function uninstallHookForProvider(provider: HookProvider): Promise<HookInstallResult> {
  let settings: SettingsJson
  try {
    const raw = await readFile(provider.settingsFile, 'utf8')
    settings = JSON.parse(raw) as SettingsJson
  } catch {
    return { provider: provider.name, action: 'not-installed' }
  }

  const hooksSection = settings.hooks
  if (!hooksSection) return { provider: provider.name, action: 'not-installed' }

  const eventGroups = hooksSection[provider.event]
  if (!eventGroups) return { provider: provider.name, action: 'not-installed' }

  const next = eventGroups
    .map(g => ({
      ...g,
      hooks: g.hooks.filter(h => !isKbHookCommand(h.command)),
    }))
    .filter(g => g.hooks.length > 0)

  const changed = next.length !== eventGroups.length || next.some((g, i) => g.hooks.length !== eventGroups[i]?.hooks.length)
  if (!changed) return { provider: provider.name, action: 'not-installed' }

  const updated: SettingsJson = { ...settings, hooks: { ...hooksSection, [provider.event]: next } }
  await writeFile(provider.settingsFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  return { provider: provider.name, action: 'updated' }
}

export async function uninstallHooks(): Promise<HookInstallResult[]> {
  return Promise.all(hookProviders().map(p => uninstallHookForProvider(p)))
}

// ─── kb skill uninstall ───────────────────────────────────────────────────────

export interface SkillUninstallResult {
  target: string
  action: 'removed' | 'not-found'
}

async function removeSkillFile(target: AgentTarget): Promise<SkillUninstallResult> {
  try {
    await stat(target.skillPath)
  } catch {
    return { target: target.name, action: 'not-found' }
  }
  await rm(target.skillPath)
  return { target: target.name, action: 'removed' }
}

/** Remove the injected KB skill section from a profile MD file. */
async function removeSkillFromProfileMd(
  label: string,
  filePath: string
): Promise<SkillUninstallResult> {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return { target: label, action: 'not-found' }
  }

  const idx = content.indexOf(PROFILE_HEADING)
  if (idx === -1) return { target: label, action: 'not-found' }

  // Find the next same-or-higher-level heading after the section, or end of file.
  // PROFILE_HEADING starts with `# ` (h1), so look for the next `\n#` after it.
  const afterSection = content.indexOf('\n#', idx + 1)
  const before = content.slice(0, idx).trimEnd()
  const stripped =
    afterSection === -1 ? before : `${before}\n${content.slice(afterSection + 1)}`

  await writeFile(filePath, stripped ? `${stripped}\n` : '', 'utf8')
  return { target: label, action: 'removed' }
}

export async function uninstallSkills(): Promise<SkillUninstallResult[]> {
  const skillRemovals = await Promise.allSettled(
    SKILLS.flatMap(({ name }) => agentTargets(name).map(t => removeSkillFile(t)))
  )
  const profileRemovals = await Promise.allSettled(
    profileSkillTargets().map(t => removeSkillFromProfileMd(t.label, t.filePath))
  )
  return [
    ...skillRemovals.flatMap(r => (r.status === 'fulfilled' ? [r.value] : [])),
    ...profileRemovals.flatMap(r => (r.status === 'fulfilled' ? [r.value] : [])),
  ]
}

export function formatSkillUninstallReport(
  results: SkillUninstallResult[],
  hookResults?: HookInstallResult[],
  mcpResults?: McpSyncResult[]
): string {
  const lines = results
    .filter(r => r.action === 'removed')
    .map(r => `✓ Removed KB skill from ${r.target}`)
  if (hookResults) {
    for (const r of hookResults) {
      if (r.action === 'updated') lines.push(`✓ Removed KB hook from ${r.provider}`)
    }
  }
  if (mcpResults) {
    for (const r of mcpResults) {
      if (r.action === 'removed') lines.push(`✓ Removed KB MCP entry from ${r.agent}`)
    }
  }
  return lines.join('\n')
}

/** Sync Cursor/Claude MCP `kb` entries to the active CLI/TUI connection (localhost default). */
export async function installMcpConfigs(config: KbConfig = {}): Promise<McpSyncResult[]> {
  return syncKbMcpConfigs({ config })
}

/** Remove managed Cursor/Claude MCP `kb` entries. */
export async function uninstallMcpConfigs(): Promise<McpSyncResult[]> {
  return uninstallKbMcpConfigs()
}
