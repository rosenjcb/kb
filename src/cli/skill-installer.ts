import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadSkill } from '../skills/loader'

const KB_DEV_WORKFLOW_SKILL = loadSkill('kb-dev-workflow')

const KB_DEV_WORKFLOW_SKILL_BLURB = `
## KB (knowledge base)

This project uses the \`kb\` CLI for durable knowledge management. The full agent skill is auto-installed at startup — see \`~/.claude/skills/kb-dev-workflow/SKILL.md\` (Claude), \`~/.cursor/rules/kb-dev-workflow.mdc\` (Cursor), or equivalent.

**Quick reference:**
- \`kb query "<topic>"\` — search before big changes
- \`kb submit "<fact>"\` — record durable decisions
- \`kb invalidate "<old-fact>"\` — correct stale knowledge
- \`kb publish notion|jekyll\` — publish to external targets
`

const SKILL_NAME = 'kb-dev-workflow'
const HASH_PREFIX = '<!-- kb-skill-hash:'

interface AgentTarget {
  name: string
  skillPath: string
  format: 'skill-md' | 'mdc'
}

function agentTargets(): AgentTarget[] {
  const home = os.homedir()
  return [
    {
      name: 'claude',
      skillPath: path.join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md'),
      format: 'skill-md',
    },
    {
      name: 'cursor',
      skillPath: path.join(home, '.cursor', 'rules', `${SKILL_NAME}.mdc`),
      format: 'mdc',
    },
    {
      name: 'codex',
      skillPath: path.join(home, '.codex', 'skills', `${SKILL_NAME}.md`),
      format: 'skill-md',
    },
    {
      name: 'github',
      skillPath: path.join(home, '.github', 'copilot-instructions', `${SKILL_NAME}.md`),
      format: 'skill-md',
    },
  ]
}

export interface SkillInstallResult {
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
    const withCursorFrontmatter = rawSkill.replace(
      /^---\n/,
      '---\nalwaysApply: true\n'
    )
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
): Promise<SkillInstallResult> {
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

export async function installSkillsGlobally(): Promise<SkillInstallResult[]> {
  const results = await Promise.allSettled(
    agentTargets().map(target => installTarget(target, KB_DEV_WORKFLOW_SKILL))
  )
  return results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
}

// ─── kb skill install (project-level blurb) ──────────────────────────────────

const PROJECT_SKILL_TARGETS = [
  { file: 'CLAUDE.md', heading: '## KB (knowledge base)' },
  { file: 'AGENTS.md', heading: '## KB (knowledge base)' },
]

export interface ProjectInstallResult {
  file: string
  action: 'injected' | 'already-present' | 'created' | 'skipped'
}

export async function installSkillIntoProject(
  cwd: string
): Promise<ProjectInstallResult[]> {
  const results: ProjectInstallResult[] = []

  for (const target of PROJECT_SKILL_TARGETS) {
    const filePath = path.join(cwd, target.file)
    let exists = false

    try {
      await stat(filePath)
      exists = true
    } catch {
      // doesn't exist
    }

    if (!exists) {
      results.push({ file: target.file, action: 'skipped' })
      continue
    }

    const content = await readFile(filePath, 'utf8')
    if (content.includes(target.heading)) {
      results.push({ file: target.file, action: 'already-present' })
      continue
    }

    await writeFile(filePath, `${content.trimEnd()}\n${KB_DEV_WORKFLOW_SKILL_BLURB}`, 'utf8')
    results.push({ file: target.file, action: 'injected' })
  }

  // If neither CLAUDE.md nor AGENTS.md exists, create AGENTS.md
  const anyInjected = results.some(r => r.action === 'injected' || r.action === 'already-present')
  if (!anyInjected) {
    const agentsPath = path.join(cwd, 'AGENTS.md')
    await writeFile(agentsPath, `# Agent Instructions\n${KB_DEV_WORKFLOW_SKILL_BLURB}`, 'utf8')
    results.push({ file: 'AGENTS.md', action: 'created' })
  }

  return results
}

export function formatSkillInstallReport(results: ProjectInstallResult[]): string {
  const lines: string[] = []
  for (const r of results) {
    if (r.action === 'injected') lines.push(`✓ Injected KB skill reference into ${r.file}`)
    else if (r.action === 'created') lines.push(`✓ Created ${r.file} with KB skill reference`)
    else if (r.action === 'already-present') lines.push(`• ${r.file} already has KB skill section`)
  }
  return lines.join('\n')
}
