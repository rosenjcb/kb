# Rust ecosystem harvest — research note

**Status:** coverage YAML declared (`rust.yaml`); inference not wired.
**Date:** 2026-07-28

## Manifests

- **`Cargo.toml`** — harvest atom. `[package].name` is canonical identity
  (crates.io hyphen form). Gloss from `[package].description`, else README /
  crate-level `//!` docs. Aliases: package name, underscore form
  (`foo-bar` → `foo_bar`), each `[[bin]].name`, directory basename.
- **Workspace** — root `Cargo.toml` with `[workspace]`.
  - `members` — dirs (globs) of member packages; each member has its own
    `Cargo.toml` with `[package]`.
  - `exclude` — skip list.
  - `default-members` — ops hint only; still harvest all members.
  - **Virtual workspace:** root has `[workspace]` and **no** `[package]` —
    root is not a package entity; only members emit candidates.
  - **Package + workspace:** root has both — emit root package **and** members.
- **`Cargo.lock`** — lock companion at workspace/package root; never an entity.
- Path deps under the workspace tree auto-join the workspace (Cargo Book); still
  prefer explicit `members` for discovery when present.

Sources:
[Workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html),
[Cargo targets](https://doc.rust-lang.org/cargo/reference/cargo-targets.html).

## Targets → kind signals

| Layout / TOML | Signal |
|---------------|--------|
| `[lib]` or `src/lib.rs` | `has_lib_target` |
| `[[bin]]` or `src/main.rs` or `src/bin/*.rs` | `has_bin_target` |
| `autobins` / `autolib` = false | honor disable; do not invent targets |
| `[[example]]` / `[[test]]` / `[[bench]]` | **not** entity signals |

One package may be lib+bin (common “library with a CLI”). Dep groups win over
targets: axum+bin → `service`, not `cli`.

## Kind rubric

| Signal | Kind | Notes |
|--------|------|--------|
| `tonic` require, no frontend | `api` | gRPC before broad server→service |
| axum / actix-web / rocket / warp / hyper / poem | `service` | hyper alone = weak |
| leptos / yew / dioxus / egui | `surface` | WASM UI + egui desktop |
| `has_bin_target`, no server deps | `cli` | |
| clap / argh / structopt | `cli` | structopt = legacy detect |
| lib only | `library` | |
| lib+bin, no stronger signal | `library` | weaker |
| else | `library` | fallback 0.4 |

## Workspace `part_of` edges

Intended edges (same shape as TS workspace → root):

- Member package name → workspace root package name (`part_of`), when root has
  `[package]`.
- Virtual workspace: member → root directory basename (or
  `[workspace.package].name` if present) as synthetic root identity — **or**
  omit `part_of` until a stable root name exists. Prefer documenting basename
  in the first harvester impl.

## Frameworks — include vs avoid

**Include:** axum (Tokio-era default), actix-web, rocket, warp, tonic, hyper
(direct only), poem; clap, argh, structopt (legacy); leptos, yew, dioxus, egui.

**Avoid as primary:** iron, nickel, gotham (dead/niche). Do not treat iced as
a default surface signal.

**Routes:** `not_implemented`. Planned AST (tier-4): axum `Router` /
`.route(...)`, actix-web route macros / `web::resource`, Rocket attributes.
tonic methods are proto contract-tier, not HTTP path strings
([ECOSYSTEM_HARVESTERS.spec.md](../../ECOSYSTEM_HARVESTERS.spec.md) §4a).

## Out of scope for this YAML

- Wiring `ecosystem-config.ts` / `ecosystem-harvesters.ts`
- Promoting tree-sitter `.rs` symbols to entities
- `Cargo.lock` / crates.io registry as identity
- Build scripts (`build.rs`) as entities
