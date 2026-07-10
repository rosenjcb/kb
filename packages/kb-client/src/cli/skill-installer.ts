import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

const KB_HOOK_SCRIPT_CONTENT = `#!/bin/bash
input=$(cat)
cmd=$(echo "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    c = d.get('command') or d.get('tool_input', {}).get('command') or ''
    print(c)
except Exception:
    pass
" 2>/dev/null)
if [ -n "$cmd" ] && echo "$cmd" | grep -qE '\\b(grep|awk|sed|find)\\b'; then
  echo "Reminder: kb query should be your first step for codebase exploration — use grep/awk/sed/find only as a last resort when kb cannot answer the question."
fi
exit 0
`

interface HookProvider {
  name: string
  configDir: string
  settingsFile: string
  event: string
  matcher: string
}

function hookProviders(): HookProvider[] {
  const home = os.homedir()
  return [
    {
      name: 'claude',
      configDir: path.join(home, '.claude'),
      settingsFile: path.join(home, '.claude', 'settings.json'),
      event: 'PreToolUse',
      matcher: 'Bash',
    },
    {
      name: 'gemini',
      configDir: path.join(home, '.gemini'),
      settingsFile: path.join(home, '.gemini', 'settings.json'),
      event: 'BeforeTool',
      matcher: 'run_shell_command',
    },
    {
      name: 'codex',
      configDir: path.join(home, '.codex'),
      settingsFile: path.join(home, '.codex', 'hooks.json'),
      event: 'PreToolUse',
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

async function installHookForProvider(
  provider: HookProvider,
  scriptPath: string
): Promise<HookInstallResult> {
  try {
    await stat(provider.configDir)
  } catch {
    return { provider: provider.name, action: 'not-installed' }
  }

  let settings: SettingsJson = {}
  try {
    const raw = await readFile(provider.settingsFile, 'utf8')
    settings = JSON.parse(raw) as SettingsJson
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  const hooksSection: HooksSection = (settings.hooks as HooksSection) ?? {}
  const eventGroups: MatcherGroup[] = hooksSection[provider.event] ?? []
  const existingGroup = eventGroups.find(g => g.matcher === provider.matcher)

  if (existingGroup) {
    const alreadyPresent = existingGroup.hooks.some(h => h.command.endsWith(KB_HOOK_SCRIPT_NAME))
    if (alreadyPresent) {
      // Update path if it changed (e.g. reinstall to different location)
      const needsUpdate = !existingGroup.hooks.some(h => h.command === scriptPath)
      if (!needsUpdate) return { provider: provider.name, action: 'skipped' }
      existingGroup.hooks = existingGroup.hooks.map(h =>
        h.command.endsWith(KB_HOOK_SCRIPT_NAME) ? { type: 'command', command: scriptPath } : h
      )
    } else {
      existingGroup.hooks.push({ type: 'command', command: scriptPath })
    }
  } else {
    eventGroups.push({ matcher: provider.matcher, hooks: [{ type: 'command', command: scriptPath }] })
  }

  const isNew = !settings.hooks || !hooksSection[provider.event]
  const updated: SettingsJson = {
    ...settings,
    hooks: { ...hooksSection, [provider.event]: eventGroups },
  }

  await mkdir(path.dirname(provider.settingsFile), { recursive: true })
  await writeFile(provider.settingsFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')

  return { provider: provider.name, action: isNew ? 'installed' : 'updated' }
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
      hooks: g.hooks.filter(h => !h.command.endsWith(KB_HOOK_SCRIPT_NAME)),
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

/** Sync Cursor/Claude MCP `kb` entries to the current CLI connection profile. */
export async function installMcpConfigs(): Promise<McpSyncResult[]> {
  return syncKbMcpConfigs()
}

/** Remove managed Cursor/Claude MCP `kb` entries. */
export async function uninstallMcpConfigs(): Promise<McpSyncResult[]> {
  return uninstallKbMcpConfigs()
}
