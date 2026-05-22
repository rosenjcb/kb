import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadSkill } from '../skills/loader'

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
  profileResults: ProjectInstallResult[]
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
  return lines.join('\n')
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

export function formatSkillUninstallReport(results: SkillUninstallResult[]): string {
  return results
    .filter(r => r.action === 'removed')
    .map(r => `✓ Removed KB skill from ${r.target}`)
    .join('\n')
}
