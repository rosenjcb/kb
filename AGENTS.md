# AGENTS.md

Guidance for AI agents (Codex and others) working in this repository.

See also `CLAUDE.md` for the full agent guide. This file repeats the changeset
rules because Codex reads `AGENTS.md` by default.

## Changesets are mandatory for source changes

Any change to shipped code under `src/` or `bin/` **must** include a changeset.
CI enforces this with the `Changeset required` job in `.github/workflows/ci.yml`.
Docs/eval/research/CI/config-only PRs are exempt.

**The version bump happens on merge to main, NOT in your PR.** Feature PRs carry
a *pending* `.changeset/*.md` and must **not** touch the version files
(`package.json`, `CHANGELOG.md`, `research/version.tex`). On merge to main, the
Changesets GitHub Action (`.github/workflows/changesets.yml`) consumes pending
changesets and opens a "Version Packages" PR that does the bump + changelog.

Add a changeset with:

```bash
pnpm run changeset
```

Locally this only *creates* a pending changeset (interactive wizard); it does not
bump the version. In a non-interactive / agent session, write the
`.changeset/<name>.md` file directly:

```md
---
"kb": minor
---

Short summary of the change.
```

Leave the `.changeset/*.md` file in the PR. Do not run `changeset version` or
edit `package.json` / `CHANGELOG.md` / `research/version.tex` by hand.
