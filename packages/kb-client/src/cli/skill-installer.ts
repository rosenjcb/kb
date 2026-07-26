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
# Scoped: fires only on repo-search commands in command position (grep/rg/find/…,
# git grep, kb query) and the native Grep/Glob tools — never on VCS/build/cloud
# tooling — and is throttled per session so it nudges instead of nagging.
# Opt out with KB_HOOK_REMINDER=false; override marker dir with KB_HOOK_STATE_DIR.
# Claude Code PreToolUse: plain stdout is ignored — emit JSON additionalContext.
# Docs: https://code.claude.com/docs/en/hooks
set -euo pipefail
input=$(cat || true)
payload=$(printf '%s' "$input" | python3 -c '
import hashlib, json, os, re, sys, tempfile, time

raw = sys.stdin.read()
try:
    d = json.loads(raw) if raw.strip() else {}
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
if os.environ.get("KB_HOOK_REMINDER", "").strip().lower() == "false":
    sys.exit(0)
tool = str(d.get("tool_name") or d.get("toolName") or "")
ti = d.get("tool_input") or d.get("toolInput") or {}
if not isinstance(ti, dict):
    ti = {}
cmd = str(d.get("command") or ti.get("command") or ti.get("cmd") or "")

SEARCH_FILTERS = ("grep", "egrep", "fgrep", "rg", "ag", "ack")
SEARCH_WALKERS = ("find", "fd", "fdfind")
WRAPPERS = ("sudo", "command", "nohup", "nice", "xargs", "time", "env")

def head_tokens(stage):
    toks = stage.strip().split()
    i = 0
    while i < len(toks):
        t = toks[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t):
            i += 1
            continue
        if t in WRAPPERS:
            i += 1
            continue
        if t == "timeout":
            i += 2
            continue
        return toks[i:]
    return []

def is_repo_search(cmd):
    # Statements first (&&, ||, ;, newline), then pipeline stages within each.
    for stmt in re.split(r"&&|\\|\\||;|\\n", cmd):
        stages = stmt.split("|")
        for si, stage in enumerate(stages):
            toks = head_tokens(stage)
            if not toks:
                continue
            head = os.path.basename(toks[0])
            if head in SEARCH_WALKERS:
                return True
            # grep-family only counts when it initiates the pipeline — filtering
            # another command output (git log | grep …) is not repo spelunking.
            if head in SEARCH_FILTERS and si == 0:
                return True
            if head == "git" and len(toks) > 1 and toks[1] == "grep":
                return True
            if head == "kb" and len(toks) > 1 and toks[1] in ("query", "graph", "docs", "facts"):
                return True
    return False

native_search = tool in ("Grep", "Glob")
if not (native_search or is_repo_search(cmd)):
    sys.exit(0)

# Throttle: at most one reminder per session per window — nudge, not nag.
TTL_SECONDS = 900
session = str(d.get("session_id") or d.get("sessionId") or "global")
state_dir = os.environ.get("KB_HOOK_STATE_DIR", "").strip() or os.path.join(
    tempfile.gettempdir(), "kb-hook-reminders"
)
key = hashlib.sha256(session.encode("utf-8", "replace")).hexdigest()[:16]
marker = os.path.join(state_dir, "kb-reminder-" + key)
now = time.time()
try:
    if now - os.path.getmtime(marker) < TTL_SECONDS:
        sys.exit(0)
except OSError:
    pass
try:
    os.makedirs(state_dir, exist_ok=True)
    with open(marker, "w") as f:
        f.write(str(int(now)))
except OSError:
    pass  # an unwritable state dir must not suppress the reminder

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

const KB_FEEDBACK_HOOK_SCRIPT_NAME = 'kb-feedback.sh'

/** Claude PostToolUse matcher for the kb MCP tools (server registered as `kb`). */
export const CLAUDE_KB_FEEDBACK_MCP_MATCHER = 'mcp__kb__kb_query|mcp__kb__submit_feedback'

/**
 * End-of-session feedback hook (Claude Code only — it is the only provider here
 * with PostToolUse/Stop JSON hook semantics). Immediate post-query judgment is
 * too early to be trustworthy, so this waits until the work is validated:
 * - PostToolUse on the kb MCP tools records per-session kb_query requestIds
 *   (and a done-marker once submit_feedback is called);
 * - PreToolUse on Bash injects one submit_feedback reminder at the first
 *   `git push` — the moment the answers have been proven out;
 * - Stop blocks once, as a fallback for sessions that never push.
 * One nudge per session total; silent after feedback. Opt out with
 * KB_FEEDBACK_REMINDER=false; marker dir override: KB_HOOK_STATE_DIR.
 */
export const KB_FEEDBACK_HOOK_SCRIPT_CONTENT = `#!/usr/bin/env bash
# kb-feedback.sh — ask agents to close the loop with submit_feedback at the END
# of the work, not right after kb_query: at the first git push (work validated)
# or, failing that, by blocking the first Stop. One nudge per session; silent
# once feedback is in. Opt out with KB_FEEDBACK_REMINDER=false.
# Docs: https://code.claude.com/docs/en/hooks
set -euo pipefail
input=$(cat || true)
payload=$(printf '%s' "$input" | python3 -c '
import hashlib, json, os, re, sys, tempfile

raw = sys.stdin.read()
try:
    d = json.loads(raw) if raw.strip() else {}
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
if os.environ.get("KB_FEEDBACK_REMINDER", "").strip().lower() == "false":
    sys.exit(0)

event = str(d.get("hook_event_name") or d.get("hookEventName") or "")
tool = str(d.get("tool_name") or d.get("toolName") or "")
session = str(d.get("session_id") or d.get("sessionId") or "global")
state_dir = os.environ.get("KB_HOOK_STATE_DIR", "").strip() or os.path.join(
    tempfile.gettempdir(), "kb-hook-reminders"
)
key = hashlib.sha256(session.encode("utf-8", "replace")).hexdigest()[:16]
used_marker = os.path.join(state_dir, "kb-feedback-used-" + key)
done_marker = os.path.join(state_dir, "kb-feedback-done-" + key)
nudged_marker = os.path.join(state_dir, "kb-feedback-nudged-" + key)

def touch(marker, text=""):
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(marker, "a") as f:
            f.write(text)
    except OSError:
        pass  # unwritable state dir must not break the hook

def walk_strings(x, out):
    if isinstance(x, str):
        out.append(x)
    elif isinstance(x, dict):
        for v in x.values():
            walk_strings(v, out)
    elif isinstance(x, list):
        for v in x:
            walk_strings(v, out)

if event == "PostToolUse":
    if tool.endswith("__kb_query"):
        chunks = []
        walk_strings(d.get("tool_response") or d.get("toolResponse") or {}, chunks)
        q = chr(34)
        ids = re.findall(q + "requestId" + q + ": *" + q + "([^" + q + "]+)" + q, chr(10).join(chunks))
        touch(used_marker, "".join(i + chr(10) for i in ids[:3]))
    elif tool.endswith("__submit_feedback"):
        touch(done_marker)
    sys.exit(0)

# Reminder paths (PreToolUse git push, Stop): only after kb_query use, before
# feedback, and at most once per session.
if not os.path.exists(used_marker):
    sys.exit(0)
if os.path.exists(done_marker) or os.path.exists(nudged_marker):
    sys.exit(0)

def request_ids():
    try:
        with open(used_marker) as f:
            ids = [line.strip() for line in f if line.strip()]
    except OSError:
        return []
    seen = []
    for i in ids:
        if i not in seen:
            seen.append(i)
    return seen[-10:]

def build_msg():
    ids = request_ids()
    idpart = ""
    if ids:
        idpart = " Echo requestIds " + json.dumps(ids) + " so the feedback joins those queries."
    return (
        "You used the kb MCP tool kb_query this session. Now that the work is done, "
        "call submit_feedback once: helped (yes|partial|no) plus notes on what the "
        "answers got right or missed." + idpart
    )

if event == "PreToolUse":
    if tool != "Bash":
        sys.exit(0)
    ti = d.get("tool_input") or d.get("toolInput") or {}
    if not isinstance(ti, dict):
        ti = {}
    cmd = str(ti.get("command") or ti.get("cmd") or "")
    WRAPPERS = ("sudo", "command", "nohup", "nice", "time", "env")
    def is_git_push(cmd):
        for stmt in re.split(r"&&|\\|\\||;|\\n", cmd):
            toks = stmt.strip().split()
            while toks and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]) or toks[0] in WRAPPERS):
                toks = toks[1:]
            if toks and os.path.basename(toks[0]) == "git" and "push" in toks[1:]:
                return True
        return False
    if not is_git_push(cmd):
        sys.exit(0)
    msg = build_msg()
    touch(nudged_marker)
    print(json.dumps({
        "systemMessage": msg,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": msg,
        },
    }))
    sys.exit(0)

if event == "Stop":
    if d.get("stop_hook_active") or d.get("stopHookActive"):
        sys.exit(0)
    msg = build_msg()
    touch(nudged_marker)
    print(json.dumps({"decision": "block", "reason": msg}))
    sys.exit(0)
' 2>/dev/null || true)
if [ -n "\${payload:-}" ]; then
  printf '%s\\n' "$payload"
fi
exit 0
`

/** Claude hook events the feedback script registers under. */
const CLAUDE_FEEDBACK_HOOK_EVENTS: Array<{ event: string; matcher: string }> = [
  { event: 'PostToolUse', matcher: CLAUDE_KB_FEEDBACK_MCP_MATCHER },
  { event: 'PreToolUse', matcher: 'Bash' },
  { event: 'Stop', matcher: '' },
]

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

async function writeHookScript(name: string, content: string): Promise<string> {
  const home = os.homedir()
  const hooksDir = path.join(home, '.kb', 'hooks')
  await mkdir(hooksDir, { recursive: true })
  const scriptPath = path.join(hooksDir, name)
  await writeFile(scriptPath, content, 'utf8')
  await chmod(scriptPath, 0o755)
  return scriptPath
}

async function ensureHookScript(): Promise<string> {
  return writeHookScript(KB_HOOK_SCRIPT_NAME, KB_HOOK_SCRIPT_CONTENT)
}

async function ensureFeedbackHookScript(): Promise<string> {
  return writeHookScript(KB_FEEDBACK_HOOK_SCRIPT_NAME, KB_FEEDBACK_HOOK_SCRIPT_CONTENT)
}

type HookEntry = { type: string; command: string }
type MatcherGroup = { matcher: string; hooks: HookEntry[] }
type HooksSection = Record<string, MatcherGroup[]>
type SettingsJson = { hooks?: HooksSection } & Record<string, unknown>

function isKbHookCommand(command: string, scriptName: string = KB_HOOK_SCRIPT_NAME): boolean {
  return command === scriptName || command.endsWith(`/${scriptName}`)
}

/** Find matcher group that already owns the named kb hook script (any matcher). */
function findGroupWithKbHook(
  groups: MatcherGroup[],
  scriptName: string = KB_HOOK_SCRIPT_NAME
): MatcherGroup | undefined {
  return groups.find(g => g.hooks.some(h => isKbHookCommand(h.command, scriptName)))
}

/**
 * Merge one kb-owned hook entry into an event's matcher groups: re-own a stale
 * entry in place (path/matcher refresh), join an existing same-matcher group,
 * or append a new group. Never touches entries owned by other tools.
 */
function mergeHookEvent(
  hooksSection: HooksSection,
  event: string,
  matcher: string,
  scriptPath: string,
  scriptName: string
): { groups: MatcherGroup[]; changed: boolean } {
  const groups = [...(hooksSection[event] ?? [])]
  const owned = findGroupWithKbHook(groups, scriptName)
  if (owned) {
    const pathOk = owned.hooks.some(h => h.command === scriptPath)
    const matcherOk = owned.matcher === matcher
    if (pathOk && matcherOk) return { groups, changed: false }
    owned.matcher = matcher
    owned.hooks = owned.hooks.map(h =>
      isKbHookCommand(h.command, scriptName) ? { type: 'command', command: scriptPath } : h
    )
    return { groups, changed: true }
  }
  const sameMatcher = groups.find(g => g.matcher === matcher)
  if (sameMatcher) {
    sameMatcher.hooks.push({ type: 'command', command: scriptPath })
  } else {
    groups.push({ matcher, hooks: [{ type: 'command', command: scriptPath }] })
  }
  return { groups, changed: true }
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
  const hadEvent = Boolean(hooksSection[provider.event]?.length)
  const hadOwned = Boolean(findGroupWithKbHook(hooksSection[provider.event] ?? []))
  const { groups, changed } = mergeHookEvent(
    hooksSection,
    provider.event,
    provider.matcher,
    scriptPath,
    KB_HOOK_SCRIPT_NAME
  )
  if (!changed) return { provider: provider.name, action: 'skipped' }
  const action: HookInstallResult['action'] = hadOwned || hadEvent ? 'updated' : 'installed'

  const updated: SettingsJson = {
    ...settings,
    hooks: { ...hooksSection, [provider.event]: groups },
  }

  await mkdir(path.dirname(provider.settingsFile), { recursive: true })
  await writeFile(provider.settingsFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')

  return { provider: provider.name, action }
}

/** Register the end-of-session feedback hook in ~/.claude/settings.json (Claude only). */
async function installFeedbackHooks(scriptPath: string): Promise<HookInstallResult> {
  const home = os.homedir()
  const configDir = path.join(home, '.claude')
  const settingsFile = path.join(configDir, 'settings.json')
  await mkdir(configDir, { recursive: true })

  let settings: SettingsJson = {}
  try {
    settings = JSON.parse(await readFile(settingsFile, 'utf8')) as SettingsJson
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  const hooksSection: HooksSection = (settings.hooks as HooksSection) ?? {}
  const nextSection: HooksSection = { ...hooksSection }
  let anyChanged = false
  let anyPreexisting = false
  for (const { event, matcher } of CLAUDE_FEEDBACK_HOOK_EVENTS) {
    const hadOwned = Boolean(
      findGroupWithKbHook(nextSection[event] ?? [], KB_FEEDBACK_HOOK_SCRIPT_NAME)
    )
    const { groups, changed } = mergeHookEvent(
      nextSection,
      event,
      matcher,
      scriptPath,
      KB_FEEDBACK_HOOK_SCRIPT_NAME
    )
    nextSection[event] = groups
    if (changed) {
      anyChanged = true
      if (hadOwned) anyPreexisting = true
    }
  }
  if (!anyChanged) return { provider: 'claude-feedback', action: 'skipped' }

  const updated: SettingsJson = { ...settings, hooks: nextSection }
  await writeFile(settingsFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  return { provider: 'claude-feedback', action: anyPreexisting ? 'updated' : 'installed' }
}

export async function installHooks(): Promise<HookInstallResult[]> {
  const scriptPath = await ensureHookScript()
  const feedbackScriptPath = await ensureFeedbackHookScript()
  const results = await Promise.all(
    hookProviders().map(p => installHookForProvider(p, scriptPath))
  )
  results.push(await installFeedbackHooks(feedbackScriptPath))
  return results
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

/** Remove the feedback hook entries from ~/.claude/settings.json (all three events). */
async function uninstallFeedbackHooks(): Promise<HookInstallResult> {
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json')
  let settings: SettingsJson
  try {
    settings = JSON.parse(await readFile(settingsFile, 'utf8')) as SettingsJson
  } catch {
    return { provider: 'claude-feedback', action: 'not-installed' }
  }

  const hooksSection = settings.hooks
  if (!hooksSection) return { provider: 'claude-feedback', action: 'not-installed' }

  let changed = false
  const nextSection: HooksSection = { ...hooksSection }
  for (const { event } of CLAUDE_FEEDBACK_HOOK_EVENTS) {
    const eventGroups = hooksSection[event]
    if (!eventGroups) continue
    const next = eventGroups
      .map(g => ({
        ...g,
        hooks: g.hooks.filter(h => !isKbHookCommand(h.command, KB_FEEDBACK_HOOK_SCRIPT_NAME)),
      }))
      .filter(g => g.hooks.length > 0)
    if (
      next.length !== eventGroups.length ||
      next.some((g, i) => g.hooks.length !== eventGroups[i]?.hooks.length)
    ) {
      changed = true
      nextSection[event] = next
    }
  }
  if (!changed) return { provider: 'claude-feedback', action: 'not-installed' }

  const updated: SettingsJson = { ...settings, hooks: nextSection }
  await writeFile(settingsFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  return { provider: 'claude-feedback', action: 'updated' }
}

export async function uninstallHooks(): Promise<HookInstallResult[]> {
  const results = await Promise.all(hookProviders().map(p => uninstallHookForProvider(p)))
  results.push(await uninstallFeedbackHooks())
  return results
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
