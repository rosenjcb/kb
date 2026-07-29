---
type: Spec
title: "Spec: Ecosystem Harvesters"
sources:
  - ./ecosystem-harvesters.ts
  - ./ecosystem-config.ts
  - ./ecosystems/
tests:
  - ../../../../tests/tools/ecosystem-harvesters.test.ts
description: Manifest-driven entity harvest — YAML coverage per ecosystem, deterministic inference
tags: [indexing, entities, ontology, harvester, spec]
timestamp: 2026-07-28T18:23:00Z
---

### Intro

Ecosystem harvesters answer “what deployable things does this repo declare?” from
manifest-class files — no LLM, no network. Coverage (frameworks, kind rubric,
infra files, declared gaps for symbols/routes) lives in reviewable YAML under
`ecosystems/` (one file per ecosystem). Inference code loads that YAML and emits
entity candidates for the `entity-index` scan cycle. Plan context:
[NOMENCLATURE_INDEX_PLAN.md](../../../../NOMENCLATURE_INDEX_PLAN.md) §4a.

### Definitions

- **Ecosystem YAML**: `ecosystems/<id>.yaml` — frameworks, kind rules, workspace
  sources, and `symbols` / `routes` coverage status.
- **Entity candidate**: `{ kind, canonicalName, aliases, gloss?, sourceFile,
  sourceKind: manifest, confidence, contentHash }` produced by a harvester.
- **Kind rubric**: ordered `kind_rules` in the TypeScript YAML; first match wins.
- **Infra tier**: language-agnostic compose / `fly.toml` / Backstage harvest
  (`ecosystems/infra.yaml`).

### Scope

## In Scope
- Loading and validating ecosystem YAML
- TypeScript/JavaScript package harvest (workspace + root)
- Deterministic package kind classification from YAML rules
- Infra manifest harvest (compose, Fly, Backstage)
- Merging ecosystem + infra candidate lists

## Out of Scope
- Entity registry upsert, fact linking, collisions — `entity-index-cycle.ts`
- Query-time scope inference / retrieval pruning
- HTTP routes and in-code symbols as entities (YAML marks `not_implemented`)
- Non-TS language ecosystems not yet shipping a YAML file

### Functional Requirements

| ID   | Requirement |
|------|-------------|
| FR-1 | Load per-ecosystem YAML with frameworks, kind rules, and declared `symbols` / `routes` coverage |
| FR-2 | Classify a package’s entity kind from YAML `kind_rules` (first match wins; weaker signals lower confidence) |
| FR-3 | Harvest workspace packages with identity, aliases, gloss, and `part_of` edges to the root package |
| FR-4 | Fall back to the root `package.json` when no workspace members exist; emit nothing when no package manifest is present |
| FR-5 | Harvest compose service keys, Fly app names, and Backstage catalog entries per `infra.yaml` |
| FR-6 | Emit no candidates from malformed infra manifests |
| FR-7 | Merge TypeScript and infra harvest results (duplicate names may appear once per source for registry merge) |
| FR-8 | Declare routes and in-code symbols as not harvested (`not_implemented` in YAML) |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|----------|------------------|
| TC-1 | FR-1 | Load `typescript.yaml` | Frameworks include express/react/commander; kind_rules present; symbols/routes `not_implemented` |
| TC-2 | FR-1 | Load `infra.yaml` | Compose files, `fly.toml`, and `catalog-info.yaml` configured |
| TC-3 | FR-2 | express deps / bin / react / main / empty package | Kinds: service, cli, surface, library; empty confidence below 0.5 |
| TC-4 | FR-3 | pnpm workspace with client (bin), server (express), core (main) | cli / service / library candidates; aliases; `part_of` → root |
| TC-5 | FR-4 | Solo package with fastify; empty directory | One service candidate; empty dir → zero candidates |
| TC-6 | FR-5 | compose + fly + Backstage present | Candidates for service keys, app name, catalog name; `belongs_to` edge |
| TC-7 | FR-6 | Malformed `docker-compose.yml` | Zero candidates |
| TC-8 | FR-7 | Same name in package.json and fly.toml | Two candidates with that canonical name |
| TC-9 | FR-8 | Inspect typescript coverage sections | `symbols.status` and `routes.status` are `not_implemented` |

### Related docs

- [NOMENCLATURE_INDEX_PLAN.md](../../../../NOMENCLATURE_INDEX_PLAN.md)
- [TREE_SITTER_INDEXER.spec.md](./TREE_SITTER_INDEXER.spec.md) — code symbols stay in code-index
