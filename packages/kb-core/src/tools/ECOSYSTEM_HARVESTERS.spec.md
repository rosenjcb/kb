---
type: Spec
title: "Spec: Ecosystem Harvesters"
sources:
  - ./ecosystem-harvesters.ts
  - ./ecosystem-config.ts
  - ./ecosystems/
tests:
  - ../../../../tests/tools/ecosystem-harvesters.test.ts
description: >-
  Ecosystem harvesters read package and infra manifests. They emit entity
  candidates. YAML files state coverage per ecosystem.
tags: [indexing, entities, ontology, harvester, spec]
timestamp: 2026-08-01T21:10:00Z
---

### Intro

An ecosystem harvester finds named things that a repository declares. It reads
manifest files and selected source patterns. It does not call an LLM. It does
not use the network.

Coverage data is in YAML files under `ecosystems/`. There is one YAML file for
each ecosystem. Each file lists frameworks, kind rules, and coverage for
symbols, routes, app classes, and models. The harvester code loads that YAML.
It emits entity candidates for the `entity-index` scan cycle. See
[NOMENCLATURE_INDEX_PLAN.md](../../../../NOMENCLATURE_INDEX_PLAN.md) §4a.

Tier-4 harvest writes registry rows for later use. Those rows can have kind
`api`, `module`, `model`, or `surface`. Tier-4 harvest does not control query
results today. You can inspect the registry with `kb entities`.

### Definitions

- **Ecosystem YAML**: A file at `ecosystems/<id>.yaml`. It lists frameworks,
  kind rules, workspace sources, and coverage for `symbols` and `routes`. It
  can also list coverage for `app_classes` and `models`.
- **Entity candidate**: A record that a harvester emits. Fields: `kind`,
  `canonicalName`, `aliases`, optional `gloss`, `sourceFile`,
  `sourceKind: manifest`, `confidence`, `contentHash`.
- **Kind rubric**: The ordered `kind_rules` list in the ecosystem YAML. The
  first matching rule sets the kind.
- **Infra tier**: Harvest from compose, `fly.toml`, and Backstage files. This
  tier is not tied to one language. See `ecosystems/infra.yaml`.
- **`model` kind**: An ORM model, table, or schema name. It is not a
  deployable service.
- **App-layer `module`**: A service, controller, or handler class in code. Do
  not use kind `service` for these. Kind `service` is for deployable units.

### Scope

## In Scope
- Load and validate ecosystem YAML
- Harvest TypeScript and JavaScript packages (workspace and root)
- Harvest Go, Python, Rust, PHP, Ruby, Java, Haskell, C++, C#, and Scala packages
- Classify package kind from YAML rules
- Harvest infra manifests (compose, Fly, Backstage, Kubernetes, Helm, Procfile)
- Harvest OpenAPI and protobuf contracts (tier-3)
- Harvest HTTP routes with regular expressions (tier-4; `routes.status: partial`)
- Harvest app classes and ORM models (tier-4; kinds `module` and `model`)
- Merge candidate lists from package, infra, contract, route, and app harvest

## Out of Scope
- Entity registry upsert, fact links, and collisions (`entity-index-cycle.ts`)
- Ambiguity lanes and ontology assembly (plan phases 4–6)
- Query rules that use new route and model entities (follow-up work)
- Full Gradle, Mill, vcpkg, and Conan identity (Maven, CMake, and sbt first)

### Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | Load each ecosystem YAML. Keep frameworks, kind rules, and `symbols` / `routes` coverage. |
| FR-2 | Set package kind from YAML `kind_rules`. Use the first match. Give lower confidence to weaker signals. |
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
| FR-21 | Harvest tier-4 HTTP routes as low-confidence `api` entities. Harvest Next.js pages as `surface`. Reject file-path false matches. |
| FR-22 | Harvest tier-4 app classes as `module`. Harvest ORM and SQL models as `model`. Do not emit kind `service` for those atoms. |
| FR-23 | Harvest extra route and model patterns: Nest method verbs, Hono, Go 1.22 ServeMux, Sinatra/Grape, Tapir `.in`, Drogon, GraphQL roots/types, Drizzle/Mongoose/Sequelize, EF `ToTable`, Exposed, Persistent lines. |
| FR-24 | Join Spring and Nest class/controller prefixes with method paths. Expand Rails `resources` to CRUD verbs. Harvest Symfony YAML routes, Slim maps, Flask MethodView `add_url_rule`, Django `include()` prefixes, tRPC procedures, OpenAPI path items, Room `tableName`, Hibernate XML, and Persistent TH blocks. |
| FR-25 | Harvest raw Node `url`/`pathname` route checks, embedded `CREATE TABLE` in source, Nest `setGlobalPrefix`, FastAPI `APIRouter(prefix=)`, Gin/chi `Group` joins, Rails `namespace`/`scope` stacks, Django `app_name`, Micronaut/JAX-RS path joins, ASGI `Route`/`Mount`, and same-document OpenAPI `$ref` path items. Capture `*Store`/`*Indexer` classes as modules. |
| FR-26 | Harvest Prisma schema declarations exhaustively: `model` / `enum` / `view` / composite `type` as kind `model`; attach block-level `@@map("…")` as a model alias. Skip `generator`, `datasource`, field `@map`, and Prisma client call-sites. Also harvest TypeORM `@Entity({ name|tableName })` table aliases. |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|----------|------------------|
| TC-1 | FR-1 | Load `typescript.yaml` | Frameworks include express, react, and commander. Kind rules are present. Symbols and routes status is `partial`. |
| TC-2 | FR-1 | Load `infra.yaml` | Compose files, `fly.toml`, and `catalog-info.yaml` are configured. |
| TC-3 | FR-2 | Package with express, bin, react, main, or empty fields | Kinds are service, cli, surface, or library. Empty package confidence is below 0.5. |
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
| TC-18 | FR-17 | `CMakeLists.txt` with `project(raylib)` | Candidate kind is `library`. Confidence is low. |
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

### Related docs

- [NOMENCLATURE_INDEX_PLAN.md](../../../../NOMENCLATURE_INDEX_PLAN.md)
- [TREE_SITTER_INDEXER.spec.md](./TREE_SITTER_INDEXER.spec.md) — Code symbols stay in the code-index.
