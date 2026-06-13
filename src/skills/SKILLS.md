# Bundled Agent Skills

KB ships first-party **Agent Skills** (Cursor/Claude/Codex format) for dogfooding and `kb skills install`. Source of truth: repo `skills/<name>/SKILL.md`; runtime loading via `loader.ts`.

## Loader (`loader.ts`)

```text
Prod:  dist/bin/<name>.skill.md   (copied at build)
Dev:   skills/<name>/SKILL.md     (tsx from src/skills/)
```

`loadSkill(name)` throws if missing — build must copy skills in `scripts/build-cli.mjs`.

## Installer (`../cli/skill-installer.ts`)

`kb skills install` runs the first three rows together (install skill files **and** update the core agent readmes + hook); `kb skills uninstall` runs `uninstallSkills()` + `uninstallHooks()`.

| Function | Target |
|---|---|
| `installSkillsGlobally()` | Per-agent skill files under `~/.claude`, `~/.cursor/rules`, `~/.codex`, `~/.github` |
| `installSkillIntoProject()` | Injects `kb:dev-workflow` body into profile MDs (`CLAUDE.md`, `AGENTS.md`) |
| `installHooks()` | Registers a kb-first pre-tool hook (`~/.kb/hooks/kb-reminder.sh`) in Claude / Gemini / Codex settings |
| `uninstallSkills()` / `uninstallHooks()` | Removes installed files, profile MD entries, and hooks matching bundled set |

**Idempotency:** Each install writes `<!-- kb-skill-hash: <sha256-prefix> -->`. Matching hash → `skipped`; mismatch → `updated`.

**Cursor:** `.mdc` targets get `alwaysApply: true` injected into YAML frontmatter.

## Bundled set

Maintained in `SKILLS` constant inside `skill-installer.ts` (must stay in sync with `skills/` directory):

- `kb:dev-workflow` — query/graph/docs conventions
- `kb:dump-context` — in-place architecture markdown (this skill)
- `kb:evaluation-run` — eval suites under `eval/`

Adding a skill:

1. Create `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`)
2. `loadSkill('<name>')` in `skill-installer.ts` + append to `SKILLS`
3. Wire build copy to `dist/bin/<name>.skill.md`
4. Optional: expose via `kb skills` in `index.ts`

## Invariants

- Skill bodies should stay **short and imperative** — they are always-on context when installed to profile MDs.
- Do not embed secrets or repo-specific paths in skills; use `kb query` / base flags in examples.
- Hash header must remain first line after install so upgrades are detectable.
