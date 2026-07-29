# Haskell ecosystem research

Date: 2026-07-28 · Coverage: `../haskell.yaml` (`status: planned`)

## Tooling verdict

- **Cabal + hpack are primary.** Entity atom = one Cabal package (`name:` in
  `*.cabal`). Prefer reading the `.cabal` file; if only `package.yaml` exists,
  treat hpack YAML as the package manifest (same fields: `name`,
  `library` / `executables`, `dependencies`).
- **`cabal.project` is the workspace source of truth.** `packages:` lists local
  package dirs/globs → `part_of` edges to a synthetic root or the project file.
- **`stack.yaml` is secondary, not dead.** Still maintained; use its `packages:`
  list only when no `cabal.project` is present. Do not prefer Stack over Cabal
  for new inference. Avoid obsolete tooling: cabal sandboxes, `cabal-dev`,
  `hsenv`, `cabal.config` freeze-as-identity.
- **Ignore lock/plan files for identity** (`cabal.project.freeze`,
  `stack.yaml.lock`) — deps pins, not package atoms.

## Kind rubric (Cabal stanzas)

| Signal | Kind |
|--------|------|
| `build-depends` hits server group (servant/yesod/scotty/warp/wai/ihp) | `service` |
| hits frontend group (reflex*/miso/threepenny-gui) | `surface` |
| `executable` stanza + CLI deps (optparse-applicative/cmdargs) | `cli` |
| `executable` only (no `library`) | `cli` (weaker) |
| `library` stanza (default Hackage shape) | `library` |

One Cabal package may declare both `library` and `executable` — classify from
deps first, then stanza presence. Multi-exe packages: one entity per package
(not per exe); exe names become aliases later if needed.

## Frameworks verified (2026-07)

| Package | Role | Status |
|---------|------|--------|
| **servant** / servant-server | typed APIs | Active — Hackage 0.20.x, Stackage; revisions into 2026 |
| **yesod** / yesod-core | batteries web | Active — yesod-core 1.7 on Hackage; on Stackage nightly 2026 |
| **scotty** | Sinatra-style WAI | Active — 0.30 (2026-01) |
| **warp** / **wai** | HTTP server / app interface | Active — foundation under Yesod/Scotty/IHP/Servant |
| **ihp** | full-stack (Nix-heavy) | Active — 1.5 / 1.6 releases 2026; Hackage `ihp` |
| **optparse-applicative** | CLI | Active — 0.19.0.0 (2025-06); de-facto standard |
| **cmdargs** | CLI | Alive but quiet — 0.10.22 (2023); keep for detection, prefer OPA |
| **reflex** / reflex-dom(-core) | FRP web UI | Active — reflex-dom-core 0.8.1.4 (2025); Obelisk commits 2026 |
| **miso** | Elm-like SPA / WASM | Active — 1.11–1.12 releases 2026 |
| **threepenny-gui** | browser-as-display GUI | Maintained — 0.9.4.2 (upload 2024-12, rev 2025-03) |

### Declined / do not list as primary

- **Spiral** — PHP framework (RoadRunner); not Haskell. Likely prompt typo for
  **Spock**.
- **Spock** — still on Hackage 0.14, but stale (Stackage LTS ~21 era; GHC 8.10
  support lists). Omit from `frameworks.server`.
- **Obelisk** — Reflex full-stack *project* scaffold (Nix/`default.nix`), not a
  common Cabal `build-depends`. Detect later via nix/obelisk markers if needed;
  surface apps still show up via `reflex` / `reflex-dom` deps.

## Routes (tier-4)

`routes.status: not_implemented`. Planned order:

1. **Servant** — type-level API (`:>`, `Get`/`Post`, `Capture`) → path+method
2. Yesod `parseRoutes` / IHP `[routes|…|]` / Scotty verb+path DSL

Never load-bearing; missing parsers only lose endpoint granularity.

## Out of scope for this YAML

- Wiring `ecosystem-config.ts` / harvester inference
- Promoting tree-sitter-haskell symbols to entities
- Nix flake-only packages with no Cabal/hpack manifest
- Stackage resolver choice as an entity signal
