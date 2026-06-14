# AGENTS.md

Guidance for AI agents (Codex and others) working in this repository.

See also `CLAUDE.md` for the full agent guide. This file repeats the changeset
rules because Codex reads `AGENTS.md` by default.

## Changesets are mandatory for source changes

Any change to shipped code under `src/` or `bin/` **must** include a version
bump via Changesets. CI enforces this with the `Changeset required` job in
`.github/workflows/ci.yml`. Docs/eval/research/CI/config-only PRs are exempt.

**Do not hand-author changeset markdown files or version files.** Always use:

```bash
pnpm run changeset
```

This is the only changeset command. It:

1. Runs the interactive changeset wizard (pick `patch` / `minor` / `major`,
   write the summary).
2. Consumes the changeset and bumps `package.json`, `CHANGELOG.md`, and
   `research/version.tex`.

Commit all three version files with your code. Do not leave pending
`.changeset/*.md` files in the PR.
