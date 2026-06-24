# AGENTS.md

Guidance for AI agents (Codex and others) working in this repository.

See also `CLAUDE.md` for the full agent guide. This file repeats the changeset
rules because Codex reads `AGENTS.md` by default.

## Changesets are mandatory for source changes

Any change to shipped code under `src/` or `bin/` **must** ship an applied
version bump on the branch before merging. CI enforces this with the
`Version bump required` job in `.github/workflows/ci.yml`. Docs/eval/research/CI/config-only PRs are exempt.

Create one pending `.changeset/<name>.md` file directly in agent/non-interactive
work:

```md
---
"kb": minor
---

Short summary of the change.
```

Then apply it with:

```bash
pnpm run changeset:version
```

This consumes the pending changeset, bumps `package.json` / `CHANGELOG.md`,
and rewrites `research/version.tex`. Do not hand-edit those version files.
