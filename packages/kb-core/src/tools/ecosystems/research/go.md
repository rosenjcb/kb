# Go ecosystem harvest — research note

**Status:** coverage YAML declared (`go.yaml`); inference not wired.

## Manifests

- **`go.mod`** — harvest atom. `module` path is canonical identity (import-path
  prefix). No `description` field; gloss from package doc comments
  ([go.dev/doc/comment](https://go.dev/doc/comment)) on `.` / `cmd/<bin>`, else
  README. Aliases: last path segment; strip `/vN` major suffix.
- **`go.work`** — workspace. `use` lists member module dirs
  ([workspaces tutorial](https://go.dev/doc/tutorial/workspaces)). Often local /
  gitignored; when committed (tight multi-module repos), treat like a workspace
  manifest. Discover all `go.mod` under the tree as fallback.
- **`go.sum`** — lock companion only; never an entity.
- Layout cues: `cmd/` + `internal/` for servers/binaries
  ([module layout](https://go.dev/doc/modules/layout)). Multi-module = nested
  `go.mod` roots, not packages-within-one-module.

## Kind rubric

| Signal | Kind | Notes |
|--------|------|--------|
| gin / echo / fiber / chi / mux | `service` | Mux = legacy detect; beats rpc→api |
| gRPC / Connect only (`rpc` group) | `api` | gin+grpc stays `service` |
| `net/http` import + `package main` (+ cmd/internal) | `service` | Stdlib; Go 1.22+ mux common |
| cobra / urfave/cli / kong | `cli` | |
| `cmd/` + main, no server deps | `cli` | |
| templ / gomponents | `surface` | Rare Go UI |
| exportable pkgs, no main | `library` | |
| else | `module` | Weak fallback |

## Frameworks — include vs avoid

**Include (detect):** gin, echo/v4, fiber/v2, chi(/v5), gorilla/mux (maintenance —
still ~17% of surveys; detect only), grpc, connectrpc, cobra, urfave/cli v2/v3,
kong, templ, gomponents.

**Avoid as primary:** martini, revel, negroni, macaron, iris (dead/abandoned/
contested). Do not treat beego as a frontier default.

**Routes:** `not_implemented`. Planned AST: chi/gin/echo/fiber registration +
`net/http` ServeMux patterns. Proto RPC ≠ HTTP route strings.

## Sources

- [go.mod reference](https://go.dev/doc/modules/gomod-ref), [modules ref](https://go.dev/ref/mod)
- [Organizing a Go module](https://go.dev/doc/modules/layout)
- JetBrains “Popular Go Web Frameworks” (2026) — gin/echo/fiber/chi/mux share
- [ECOSYSTEM_HARVESTERS.spec.md](../../ECOSYSTEM_HARVESTERS.spec.md) (tier-2 manifests; tier-4 routes optional)
