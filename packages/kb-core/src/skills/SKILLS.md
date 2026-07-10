---
type: "Subsystem"
title: "Bundled Agent Skills"
description: "The first-party agent skills KB ships for dogfooding and kb skills install, and how to add one."
resource: ./src/skills
tags: [skills, agents, install]
timestamp: 2026-06-20T00:00:00Z
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

`kb skills install` runs skill files, profile readmes, hooks, **and** MCP client sync together; `kb skills uninstall` reverses those.

| Function | Target |
|---|---|
| `installSkillsGlobally()` | Per-agent skill files under `~/.claude`, `~/.cursor/rules`, `~/.codex`, `~/.github` |
| `installSkillIntoProject()` | Injects `kb:dev-workflow` body into profile MDs (`CLAUDE.md`, `AGENTS.md`) |
| `installHooks()` | Registers a kb-first pre-tool hook (`~/.kb/hooks/kb-reminder.sh`) in Claude / Gemini / Codex settings |
| `installMcpConfigs()` | Rewrites Cursor/Claude `kb` MCP entries to `${KB_SERVER_URL\|host:port}/mcp` |
| `uninstallSkills()` / `uninstallHooks()` / `uninstallMcpConfigs()` | Removes installed files, profile MD entries, hooks, and managed MCP entries |

**Idempotency:** Each install writes `<!-- kb-skill-hash: <sha256-prefix> -->`. Matching hash → `skipped`; mismatch → `updated`.

**Cursor:** `.mdc` targets get `alwaysApply: true` injected into YAML frontmatter.

**MCP sync:** `mcp-config-sync.ts` keeps `~/.cursor/mcp.json` and `~/.claude.json` `mcpServers.kb` pointed at the same node as the CLI. Also runs fire-and-forget on normal `kb` startup (after connection env is applied). Skipped when `KB_LOCAL_MODE=true`.

## Bundled set

Maintained in `SKILLS` constant inside `skill-installer.ts` (must stay in sync with `skills/` directory):

- `kb:dev-workflow` — MCP-first query/graph/docs conventions (CLI fallback)
- `kb:dump-context` — in-place OKF companions + sibling `*.spec.md` behavioral specs (spec.md FR/TC)
- `kb:evaluation-run` — eval suites under `eval/`

Adding a skill:

1. Create `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`)
2. `loadSkill('<name>')` in `skill-installer.ts` + append to `SKILLS`
3. Wire build copy to `dist/bin/<name>.skill.md`
4. Optional: expose via `kb skills` in `index.ts`

## Invariants

- Skill bodies should stay **short and imperative** — they are always-on context when installed to profile MDs.
- Do not embed secrets or repo-specific paths in skills; use `kb query` / MCP tools / base flags in examples.
- Hash header must remain first line after install so upgrades are detectable.
- MCP `kb` URL must track the CLI connection profile — never hard-code a host in the skill body.
