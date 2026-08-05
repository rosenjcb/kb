---
type: Spec
title: "Spec: Ecosystem Harvesters"
sources:
  - ./ecosystem-harvesters.ts
  - ./ecosystem-config.ts
  - ./pattern-engine.ts
  - ./ecosystems/
  - ./ecosystems/common.yaml
tests:
  - ../../../../tests/tools/ecosystem-harvesters.test.ts
description: >-
  Ecosystem harvesters read package and infra manifests. They emit entity
  candidates. YAML source_patterns drive tier-4 route and app harvest.
tags: [indexing, entities, ontology, harvester, spec]
timestamp: 2026-08-02T02:00:00Z
---

### Intro

An ecosystem harvester finds named things that a repository declares. It reads
manifest files and selected source patterns. It does not call an LLM. It does
not use the network.

Coverage data is in YAML files under `ecosystems/`. There is one YAML file for
each ecosystem, plus `common.yaml` for cross-language rules. Each package file
lists frameworks, kind rules, coverage notes, and executable `source_patterns`.
The pattern engine loads those rules. It emits entity candidates for the
`entity-index` scan cycle. See
this specification (§4a / harvester tiers).

Tier-4 harvest writes registry rows for later use. Those rows can have kind
`api`, `module`, `model`, or `surface`, and carry `sourceKind: source-pattern`.
Tier-4 harvest does not control query results today. You can inspect the registry
with `kb entities`.

A harvest emits edges as well as candidates. Edges are what make the registry a
graph rather than a list of names, so the `entity-index` cycle reports how many it
wrote, how many `depends_on` targets were third-party, and how many structural
endpoints it could not resolve. A non-zero unresolved count is a harvester bug: an
edge named a container that nothing harvested.

### Definitions

- **Ecosystem YAML**: A file at `ecosystems/<id>.yaml`. It lists frameworks,
  kind rules, workspace sources, coverage notes, and `source_patterns`.
- **Source pattern**: One YAML rule under `source_patterns`. It sets `kind`,
  file filters, a named `strategy`, and optional regex or join fields.
- **Pattern engine**: The runner in `pattern-engine.ts`. It walks the repo. It
  applies each source pattern. It emits entity candidates.
- **Named strategy**: A fixed join or parse algorithm in TypeScript. YAML
  selects it by id. Examples: `regex`, `class_method_prefix_join`,
  `rails_resources_crud`. This is not a free-form join DSL.
- **Entity candidate**: A record that a harvester emits. Fields: `kind`,
  `canonicalName`, `aliases`, optional `gloss`, `sourceFile`, `sourceKind`,
  `contentHash`. A candidate carries no weight.
- **Provenance (`sourceKind`)**: Which extraction path produced the name.
  `manifest` = parsed from a file that declares identity, taking the identity it
  declares. `source-pattern` = found by a YAML `source_pattern` run over ordinary
  source. The emitting module is the boundary: `ecosystem-harvesters.ts` emits
  `manifest`, `pattern-engine.ts` emits `source-pattern`. This records where a
  name came from; it is not a ranking and implies no trust ordering.
- **Kind rubric**: The ordered `kind_rules` list in the ecosystem YAML. The
  first matching rule sets the kind. `library` is the fallback when none match.
- **Hand-assigned weight**: A `confidence`, `weight`, or `score` constant written
  into a harvest rule by its author. Rules must not carry one; config load rejects
  the key. A rule either describes the thing in front of it or it does not, and a
  rule too weak to act on is deleted rather than discounted.
- **Infra tier**: Harvest from compose, `fly.toml`, and Backstage files. This
  tier is not tied to one language. See `ecosystems/infra.yaml`.
- **`model` kind**: An ORM model, table, or schema name. It is not a
  deployable service.
- **App-layer `module`**: A service, controller, or handler class in code. Do
  not use kind `service` for these. Kind `service` is for deployable units.

### Scope

## In Scope
- Load and validate ecosystem YAML, including `source_patterns` and `common.yaml`
- Harvest TypeScript and JavaScript packages (workspace and root)
- Harvest Go, Python, Rust, PHP, Ruby, Java, Haskell, C++, C#, and Scala packages
- Classify package kind from YAML rules
- Harvest infra manifests (compose, Fly, Backstage, Kubernetes, Helm, Procfile)
- Harvest OpenAPI and protobuf contracts (tier-3)
- Harvest HTTP routes from YAML `source_patterns` (tier-4; `routes.status: partial`)
- Harvest app classes and ORM models from YAML `source_patterns` (tier-4)
- Run named strategies in the pattern engine; fail on an unknown strategy id
- Merge candidate lists from package, infra, contract, route, and app harvest

## Out of Scope
- Entity registry upsert, fact links, and collisions (`entity-index-cycle.ts`)
- Ambiguity lanes and ontology assembly (plan phases 4–6)
- Query rules that use new route and model entities (follow-up work)
- A free-form YAML join DSL (named strategies only)
- Weights of any kind on harvest rules or emitted candidates (FR-32)
- Full Gradle, Mill, vcpkg, and Conan identity (Maven, CMake, and sbt first)

### Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | Load each ecosystem YAML. Keep frameworks, kind rules, and `symbols` / `routes` coverage. |
| FR-2 | [UPDATED] Set package kind from YAML `kind_rules`. Use the first match; fall back to `library`. Emit no weight. |
| FR-3 | Harvest workspace packages. Keep identity, aliases, gloss, and `part_of` edges to the root package. |
| FR-4 | If there are no workspace members, harvest the root `package.json`. If there is no package manifest, emit no candidates. |
| FR-5 | Harvest compose service keys, Fly app names, and Backstage catalog entries as set in `infra.yaml`. |
| FR-6 | If an infra manifest is not valid, emit no candidates from that file. |
| FR-7 | Merge TypeScript and infra harvest results. The same name can appear once per source before registry merge. |
| FR-8 | Mark route and app-layer coverage as `partial` when the harvester supports that ecosystem. Reject false path and name matches. |
| FR-9 | Keep one YAML coverage file for each tree-sitter language ecosystem and for infra. |
| FR-10 | Harvest Go modules from `go.mod` with the YAML kind rubric. |
| FR-11 | Harvest Python projects from `pyproject.toml` with the YAML kind rubric. |
| FR-12 | Harvest Rust packages from `Cargo.toml` with the YAML kind rubric. |
| FR-13 | Harvest PHP packages from `composer.json` with the YAML kind rubric. |
| FR-14 | Harvest Ruby packages from `*.gemspec` or Gemfile with the YAML kind rubric. |
| FR-15 | Harvest Java Maven modules from `pom.xml` with the YAML kind rubric. Gradle settings include is optional. |
| FR-16 | Harvest Haskell packages from `*.cabal` or `package.yaml` with the YAML kind rubric. |
| FR-17 | Harvest C/C++ projects from `CMakeLists.txt` `project()` with the YAML kind rubric. |
| FR-18 | Harvest C# projects from `*.csproj` with the YAML kind rubric. A `.sln` `part_of` edge is optional. |
| FR-19 | Harvest Scala projects from `build.sbt` `name :=` with the YAML kind rubric. |
| FR-20 | Harvest Kubernetes, Helm, Procfile, OpenAPI, and protobuf candidates as `service` or `api`. |
| FR-21 | Harvest tier-4 HTTP routes as `api` entities from YAML `source_patterns`. Harvest Next.js pages as `surface`. Reject file-path false matches. |
| FR-22 | [UPDATED] Harvest tier-4 app classes as `module` and ORM models as `model` from YAML `source_patterns`. Do not emit kind `service` for those atoms. |
| FR-23 | Harvest extra route and model patterns: Nest method verbs, Hono, Go 1.22 ServeMux, Sinatra/Grape, Tapir `.in`, Drogon, GraphQL roots/types, Drizzle/Mongoose/Sequelize, EF `ToTable`, Exposed, Persistent lines. |
| FR-24 | Join Spring and Nest class/controller prefixes with method paths. Expand Rails `resources` to CRUD verbs. Harvest Symfony YAML routes, Slim maps, Flask MethodView `add_url_rule`, Django `include()` prefixes, tRPC procedures, OpenAPI path items, Room `tableName`, Hibernate XML, and Persistent TH blocks. |
| FR-25 | Harvest raw Node `url`/`pathname` route checks, embedded `CREATE TABLE` in source, Nest `setGlobalPrefix`, FastAPI `APIRouter(prefix=)`, Gin/chi `Group` joins, Rails `namespace`/`scope` stacks, Django `app_name`, Micronaut/JAX-RS path joins, ASGI `Route`/`Mount`, and same-document OpenAPI `$ref` path items. Capture `*Store`/`*Indexer` classes as modules. |
| FR-26 | Harvest Prisma schema declarations exhaustively: `model` / `enum` / `view` / composite `type` as kind `model`; attach block-level `@@map("…")` as a model alias. Skip `generator`, `datasource`, field `@map`, and Prisma client call-sites. Also harvest TypeORM `@Entity({ name|tableName })` table aliases. |
| FR-27 | [NEW] Drive tier-4 route and app harvest from YAML `source_patterns` in `common.yaml` and each language ecosystem YAML. |
| FR-28 | [NEW] Run each source pattern through a named strategy in the pattern engine (`regex`, join strategies, and specialized parsers). |
| FR-29 | [NEW] Reject an unknown `strategy` id at config load. Do not run the harvest for that config. |
| FR-30 | [NEW] Allow a contributor to add a simple regex source pattern in YAML without a TypeScript change. |
| FR-31 | Keep package kind classification on YAML `frameworks` and `kind_rules` (unchanged path). |
| FR-32 | Reject a `confidence` / `weight` / `score` key on any `kind_rule` or `source_pattern` at config load. Harvest rules carry no hand-assigned weights. |
| FR-33 | [NEW] Record provenance on every candidate: manifest parsing emits `sourceKind: manifest`, pattern-engine harvest emits `sourceKind: source-pattern`. |
| FR-34 | [NEW] Harvest the container an edge names as a candidate in its own right: the workspace root package, the Gradle root project, and the `.sln` solution. A `part_of` edge must never name an entity nothing harvested. |
| FR-35 | [NEW] Emit `depends_on` edges from the dependency lists each package harvester already parses for the kind rubric. |
| FR-36 | [NEW] Derive containment in the `entity-index` cycle: every candidate is `part_of` the nearest package that owns its source file, and every package is `part_of` the repo entity. |
| FR-37 | [NEW] Resolve edge endpoints against this run's candidates, the repo entity, and the rest of the base's registry. Report resolved (`edgesWritten`), third-party `depends_on` targets (`edgesExternal`), and unresolved structural endpoints (`edgesDropped`) — never drop an edge silently. |
| FR-38 | [NEW] Never mint a stub entity for an unresolved `depends_on` target. A third-party package stays out of the registry. |
| FR-39 | [NEW] Degrade to a clean no-op when nothing can be harvested (no ecosystem profile, no manifest): the repo entity only, zero edges written, zero dropped. |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|----------|------------------|
| TC-1 | FR-1 | Load `typescript.yaml` | Frameworks include express, react, and commander. Kind rules are present. Symbols and routes status is `partial`. |
| TC-2 | FR-1 | Load `infra.yaml` | Compose files, `fly.toml`, and `catalog-info.yaml` are configured. |
| TC-3 | FR-2 | Package with express, bin, react, main, or empty fields | Kinds are service, cli, surface, or library. An empty package falls back to `library`. |
| TC-4 | FR-3 | pnpm workspace with client (bin), server (express), and core (main) | Candidates are cli, service, and library. Aliases exist. `part_of` points to root. |
| TC-5 | FR-4 | Solo package with fastify; empty directory | One service candidate for the package. Empty directory yields zero candidates. |
| TC-6 | FR-5 | Compose, fly, and Backstage files are present | Candidates exist for service keys, app name, and catalog name. A `belongs_to` edge exists. |
| TC-7 | FR-6 | Malformed `docker-compose.yml` | Zero candidates. |
| TC-8 | FR-7 | Same name in `package.json` and `fly.toml` | Two candidates share that canonical name. |
| TC-9 | FR-8 | Inspect TypeScript coverage sections | `symbols.status` and `routes.status` are `partial`. |
| TC-10 | FR-9 | List ecosystem YAML ids | List includes go, python, rust, ruby, java, csharp, php, scala, haskell, cpp, css, html, bash, infra, and typescript. |
| TC-11 | FR-10 | `go.mod` that requires gin | Candidate kind is `service`. Canonical name is the module path. |
| TC-12 | FR-11 | `pyproject.toml` with fastapi | Candidate kind is `service`. |
| TC-13 | FR-12 | `Cargo.toml` with clap and `[[bin]]` | Candidate kind is `cli`. |
| TC-14 | FR-13 | `composer.json` that requires laravel/framework | Candidate kind is `service`. |
| TC-15 | FR-14 | Gemfile with rails and no gemspec | Candidate kind is `service`. Name is the scan directory basename. |
| TC-16 | FR-15 | Multi-module pom with a spring-boot-starter-web member | Parent and payments candidates exist. Payments kind is `service`. A `part_of` edge exists. |
| TC-17 | FR-16 | `billing.cabal` with servant | Candidate kind is `service`. |
| TC-18 | FR-17 | `CMakeLists.txt` with `project(raylib)` | Candidate kind is `library`. |
| TC-19 | FR-18 | Sdk.Web csproj and `.sln` | Candidate kind is `service`. A `part_of` edge points to the solution name. |
| TC-20 | FR-19 | `build.sbt` with name storefront and play | Candidate kind is `service`. |
| TC-21 | FR-20 | Kubernetes Deployment or Ingress, Helm Chart, and Procfile | Candidates have kind `service` or `api`. |
| TC-22 | FR-20 | OpenAPI file (title + path items) and protobuf `service` | Candidates have kind `api` for title, paths, and operations. |
| TC-23 | FR-21 | Nest, Express, FastAPI, Go, Spring, Next, and Rails routes plus a junk path | API routes are harvested. Next pages have kind `surface`. Junk paths are skipped. |
| TC-24 | FR-22 | Spring, Nest, Django, Prisma, .NET, Rails, and SQL app or DB types | Candidates have kind `module` or `model`. No candidate has deployable kind `service`. |
| TC-25 | FR-23 | Nest methods, Hono, Go 1.22 mux, Drizzle/Mongoose/Sequelize, GraphQL, Sinatra, EF ToTable | Extra routes and models are harvested. Nest joins controller + method (`GET /orders/:id`). |
| TC-26 | FR-24 | Spring join, Rails CRUD, Flask MethodView, Django include, tRPC, Slim, Symfony YAML, Room, Hibernate XML, Persistent TH | Joined routes, CRUD expansions, and ORM models are harvested. |
| TC-27 | FR-25 | Raw Node HTTP, embedded SQL DDL, Nest global prefix, FastAPI router prefix, Gin Group, Rails namespace, Django app_name, Micronaut/JAX-RS join, ASGI Route, OpenAPI `$ref`, Store/Indexer classes | kb-like api/model/module candidates and Round-4 route joins are harvested. |
| TC-28 | FR-26 | Rich `schema.prisma` with model, enum, view, composite type, `@@map`, and TypeORM `@Entity({ name })` | Prisma atoms are kind `model`; `@@map` / entity `name` appear as aliases. Generator/datasource are not harvested. |
| TC-29 | FR-27 | Load `typescript.yaml` and `common.yaml` | `source_patterns` lists are non-empty. Common includes OpenAPI and GraphQL rules. |
| TC-30 | FR-30 | Inline regex `source_pattern` for `@DemoRoute('…')` with no new strategy | Harvest emits the matching `api` candidate from that rule alone. |
| TC-31 | FR-29 | Source pattern with `strategy: not_a_real_strategy` | Config load throws. Message names the unknown strategy. |
| TC-32 | FR-28 | `typescript.yaml` includes `class_method_prefix_join` for Nest | Route harvest emits a joined Nest method path (`GET /orders/:id`). |
| TC-33 | FR-31 | Package.json with express only | Kind rubric from YAML `kind_rules` sets kind `service`. |
| TC-34 | FR-32 | `source_pattern` or `kind_rule` carrying `confidence` / `weight` / `score` | Config load throws. Message names the offending key. |
| TC-35 | FR-33 | Repo with a package manifest, an infra manifest, a route decorator, and a table declaration | Manifest-derived candidates are `sourceKind: manifest`; route and model candidates are `sourceKind: source-pattern`. |
| TC-36 | FR-34, FR-37 | Workspace whose globs do not list the root (`workspaces: ["packages/*"]`) | The member gets a `part_of` edge to the root package. `edgesDropped` is 0. |
| TC-37 | FR-36 | Solo package in a repo with a slug | The package gets a `part_of` edge to the repo entity. |
| TC-38 | FR-36 | Prisma model under `packages/api/prisma/` in a workspace | The model is `part_of` `@acme/api` — the nearest enclosing package, not the repo root. |
| TC-39 | FR-35, FR-38 | Workspace member depending on a sibling package and on `express` | A `depends_on` edge links the two packages; `express` counts as `edgesExternal` and mints no entity. |
| TC-40 | FR-39 | Repo with no manifest and no ecosystem profile (a lone `main.zig`) | One entity (the repo), 0 edges written, 0 dropped. |

### Related docs

- [TREE_SITTER_INDEXER.spec.md](./TREE_SITTER_INDEXER.spec.md) — Code symbols stay in the code-index.
- [ecosystems/README.md](./ecosystems/README.md) — How to add a library rule or a named strategy.
