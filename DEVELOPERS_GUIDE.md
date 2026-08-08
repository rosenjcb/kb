# KB Developers Guide

You landed here because you're **working on the KB repo itself** — not just using `kb` on your projects. This guide covers checkout setup, the scripts you'll run every day, and where the deeper docs live.

**Using KB as a tool?** Start with [README.md](README.md) instead.

---

## First-time setup

From a fresh clone, one command installs workspace deps, builds both binaries, and symlinks `kb` + `kb-server` into `$PNPM_HOME/bin`:

```bash
git clone https://github.com/rosenjcb/kb.git && cd kb
pnpm run install:global
```

That also satisfies eval harness prerequisites (`node_modules`, built `packages/kb-client/dist/bin/kb`, and `scripts/eval-index.ts` runnable via `pnpm exec tsx` from this checkout).

Requirements: **Node 24+** (checked by the script). The monorepo uses pnpm workspaces.

Optional checks after install:

```bash
pnpm run check          # format + lint (Biome)
pnpm run unit:test
```

Remove dev symlinks: `pnpm run uninstall:global` (prompts before deleting `~/.kb` data).

---

## Monorepo layout

Three shipped packages plus workspace orchestration at the root:

| Package | Binary | What it owns |
|---------|--------|--------------|
| [`@kb/client`](packages/kb-client/CLIENT.md) | `kb` | CLI, TUI, HTTP client |
| [`@kb/server`](packages/kb-server/src/SERVER.md) | `kb-server` | REST, SSE, MCP, daemon lifecycle |
| [`@kb/core`](packages/kb-core/CORE.md) | — | Indexing, retrieval, LLM, shared ops |

Full stack diagram and data paths: [`packages/ARCHITECTURE.md`](packages/ARCHITECTURE.md).

Source layout mirrors tests — `packages/kb-core/src/...` → `tests/...`. See [`TESTING.md`](TESTING.md).

---

## Daily development loop

```bash
pnpm run dev              # kb client from TS; loads .env.local when present
pnpm run dev:server       # alias of server:start (kill :38117, then --with-mcp)

pnpm run build            # compile all three packages
pnpm run type-check       # tsc across packages
pnpm run lint             # Biome
pnpm run test             # Vitest unit/integration (alias: unit:test)
pnpm run test:watch       # Vitest watch mode
```

Before opening a PR, run what CI runs:

```bash
pnpm run precommit        # lint staged + type-check + lint + spec:check + test
```

Or step through manually:

```bash
pnpm run type-check && pnpm run lint && pnpm run spec:check && pnpm run test
```

### Behavioral specs

Requirements live in sibling `*.spec.md` files (FR/TC tables). Tests that prove a TC must be tagged `[TC-N]` in the test name. CI enforces coverage with the [`spec-md`](https://github.com/rosenjcb/spec.md/tree/main/cli) CLI via:

```bash
pnpm run spec:check
```

Conventions and enforcement detail: [`TESTING.md`](TESTING.md).

---

## Running kb-server locally

**Fast path** (TypeScript, no Docker):

```bash
export GEMINI_API_KEY=<key>   # or another provider
pnpm run server:start         # kill whatever holds :38117, then kb-server start --with-mcp
```

**Docker Compose** (integration parity, WireMock LLM stub):

```bash
pnpm run server:up            # seeds .env on first run; build + boot
pnpm run server:docker:logs
curl http://localhost:38117/healthz
pnpm run server:stop
```

Point a built client at it:

```bash
export KB_HOST=localhost
export KB_PORT=38117
kb query "smoke test"
```

**HTTP integration suite** (Docker only — spins server, runs httpyac, tears down):

```bash
pnpm run integration:test
```

Manifest and env reference: [`packages/kb-server/README.md`](packages/kb-server/README.md) · [`packages/kb-server/http/HTTP.md`](packages/kb-server/http/HTTP.md).

The `kb` client always talks HTTP to a host (`KB_HOST` / `KB_CONNECTION_STRING` / `--host`). Eval indexing uses `scripts/eval-index.ts` (direct `@kb/core`) before attaching a live `kb-server`.

---

## Evaluations

KB ships harnesses for measuring answer quality and exploration cost. Two entry points:

```bash
pnpm run eval -- --suite raylib --auto-score   # canonical external benchmark
pnpm run eval -- --suite kb --auto-score       # dogfood smoke on this repo
```

`eval-run.mjs` orchestrates init/scan via `scripts/eval-index.ts` (offline `@kb/core`), then remote queries against a live `kb-server`. Multi-suite batches share **one multi-base `kb-server`** (children attach with `--base` / `X-KB-Base`); `--per-suite-server` restores one process per suite. Artifacts land under `~/.kb/evaluations/`. Override bases, repos, and scoring in suite YAML under `eval/suites/`.

| Doc | Contents |
|-----|----------|
| [`EVALUATION.md`](EVALUATION.md) | Methodology, ΔS / S / pass@3, base naming (`eval-{suiteId}` vs `dogfood`) |
| [`eval/EVAL.md`](eval/EVAL.md) | Harness internals, multi-base batch, MOEL pipelines |
| [`scripts/eval-server.mjs`](scripts/eval-server.mjs) | Start/attach kb-server; `/healthz?base=` readiness |

**Dogfood base** for architecture work on your checkout: `kb base use dogfood` (separate from disposable `eval-*` bases).

---

## Version bumps & releases

Any change under `packages/kb-client`, `packages/kb-core`, or `packages/kb-server` shipped source **must** include an applied version bump on the branch. CI fails PRs that skip this.

1. Add one `.changeset/*.md` describing the change and bump type (`patch` / `minor` / `major`).
2. Apply: `pnpm run changeset:version` (updates `package.json`, `CHANGELOG.md`, `research/version.tex`).
3. Commit the bumped files; the consumed changeset disappears.

Verify locally before push:

```bash
pnpm run changeset:check
```

`@kb/client` and `@kb/server` version independently. Full agent rules: [`AGENTS.md`](AGENTS.md) · [`CLAUDE.md`](CLAUDE.md).

Publish (maintainers, merge to main): automated via `.github/workflows/changesets.yml`. Manual: `pnpm run release`.

---

## Research & paper artifacts

LaTeX lives under `research/`. Version string syncs from package bumps:

```bash
pnpm run research:build     # latexmk → research/main.pdf
pnpm run research:results   # regenerate results tables from eval output
```

---

## Related docs

| Topic | Path |
|-------|------|
| End-user quick start | [README.md](README.md) |
| Monorepo architecture | [packages/ARCHITECTURE.md](packages/ARCHITECTURE.md) |
| Client connection / env | [packages/kb-client/CLIENT.md](packages/kb-client/CLIENT.md) |
| Server deploy & Docker | [packages/kb-server/README.md](packages/kb-server/README.md) |
| Init / scan internals | [packages/kb-core/src/core/INIT.md](packages/kb-core/src/core/INIT.md) |
| Query / chat internals | [packages/kb-core/src/core/QUERY_INTERNALS.md](packages/kb-core/src/core/QUERY_INTERNALS.md) |
| Install script (releases) | [scripts/INSTALL.md](scripts/INSTALL.md) |
| Philosophy & design | [PHILOSOPHY.md](PHILOSOPHY.md) |
