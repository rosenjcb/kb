---
type: "Subsystem"
title: "Bundled Agent Skills"
description: "The first-party agent skills KB ships for dogfooding and kb skills install, and how to add one."
resource: ./src/skills
tags: [skills, agents, install]
timestamp: 2026-07-11T00:00:00Z
---

# Bundled Agent Skills

KB ships first-party **Agent Skills** (Cursor/Claude/Codex format) for dogfooding and `kb skills install`. Source of truth: repo `skills/<name>/SKILL.md`; runtime loading via `loader.ts`.

## Loader (`loader.ts`)

```text
Prod:  dist/bin/<name>.skill.md   (copied at build)
Dev:   skills/<name>/SKILL.md     (tsx from src/skills/)
```

`loadSkill(name)` throws if missing — build must copy skills in `scripts/build-cli.mjs`.

## Installer (`../cli/skill-installer.ts`)

`kb skills install` runs skill files, profile readmes, hooks, **and** MCP client install together; `kb skills uninstall` reverses those. Opt-in only — CLI/TUI startup does **not** auto-install skills or rewrite MCP configs.

| Function | Target |
|---|---|
| `installSkillsGlobally()` | Per-agent skill files under `~/.claude`, `~/.cursor/rules`, `~/.codex`, `~/.github` |
| `installSkillIntoProject()` | Injects `kb:dev-workflow` body into profile MDs (`CLAUDE.md`, `AGENTS.md`) |
| `installHooks()` | Registers kb-first PreToolUse hook (`~/.kb/hooks/kb-reminder.sh`) — Claude matcher `Bash\|Grep\|Glob`, JSON `additionalContext` (plain stdout is ignored) |
| `installMcpConfigs()` | Rewrites Cursor/Claude `kb` MCP entries to `${KB_SERVER_URL\|host:port}/mcp` |
| `uninstallSkills()` / `uninstallHooks()` / `uninstallMcpConfigs()` | Removes installed files, profile MD entries, hooks, and managed MCP entries |

**Idempotency:** Each install writes `<!-- kb-skill-hash: <sha256-prefix> -->`. Matching hash → `skipped`; mismatch → `updated`.

**Cursor:** `.mdc` targets get `alwaysApply: true` injected into YAML frontmatter.

**MCP install:** `mcp-config-sync.ts` writes `~/.cursor/mcp.json` and `~/.claude.json` `mcpServers.kb` only when the host is **explicit** (`kb mcp install --host …`, or `KB_SERVER_URL` / `KB_HOST`). Never invents localhost. Prefer `kb mcp install` / `kb mcp status` over relying on skills install.

## Bundled set

Maintained in `SKILLS` constant inside `skill-installer.ts` (must stay in sync with `skills/` directory):

- `kb:dev-workflow` — agents investigate via **MCP connection only** (CLI/TUI is for humans); explicit local/remote host protocol
- `kb:dump-context` — in-place OKF companions + sibling `*.spec.md` behavioral specs (spec.md FR/TC)
- `kb:evaluation-run` — eval suites under `eval/`

Adding a skill:

1. Create `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`)
2. `loadSkill('<name>')` in `skill-installer.ts` + append to `SKILLS`
3. Wire build copy to `dist/bin/<name>.skill.md`
4. Optional: expose via `kb skills` in `index.ts`

## Invariants

- Skill bodies should stay **short and imperative** — they are always-on context when installed to profile MDs.
- Do not embed secrets or repo-specific paths in skills; use MCP tools / base flags in examples.
- Hash header must remain first line after install so upgrades are detectable.
- Dev-workflow: agents use the MCP connection only; CLI/TUI is the human surface (agents may run `kb mcp install` for setup, never `kb query`).
- MCP `kb` URL follows the active CLI/TUI connection (`--host` / env / localhost default).
- Do not auto-install skills or MCP from CLI/TUI startup — opt-in commands only.
