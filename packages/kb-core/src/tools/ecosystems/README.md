# Ecosystem harvester YAML

One file per language, plus:

- `infra.yaml` — language-agnostic deploy manifests (compose, Fly, Backstage, …)
- `common.yaml` — cross-language `source_patterns` (OpenAPI, GraphQL, SQL DDL, raw Node HTTP, …)

These files are the **driver** for harvest scope. The TypeScript engine in
`pattern-engine.ts` executes `source_patterns`. Package identity still uses
`frameworks` / `kind_rules` in each language file.

## Top-level `status`

| Value | Meaning |
|-------|---------|
| `implemented` | Harvest cycle reads this file and emits entities |
| `planned` | Coverage declared; package harvest not wired yet |
| `not_applicable` | No package/deploy ecosystem (css/html/bash) |

`research/` holds optional rationale notes. Not loaded at runtime.

## Contributor workflow

| Goal | Edit |
|------|------|
| New one-line annotation / macro / table helper | Add a `source_patterns` entry with `strategy: regex` in the right ecosystem YAML (or `common.yaml`) |
| New dependency → package kind | Existing `frameworks` + `kind_rules` |
| New multi-step join shape (class+method, include() prefixes, …) | Add a named strategy in `pattern-engine.ts`, then point YAML at `strategy: <name>` |

### Regex rule (YAML only)

```yaml
source_patterns:
  - id: my_lib_route
    kind: api
    gloss: MyLib route
    confidence: 0.5
    filter: plausible_http_route
    strategy: regex
    pattern: '@MyRoute\s*\(\s*[''"]([^''"]+)[''']'
    flags: g
    name_group: 1
    files:
      extensions: [.ts, .tsx]
```

### Named strategies (TypeScript)

`regex` · `class_method_prefix_join` · `router_group_prefix_join` ·
`rails_resources_crud` · `django_include_join` · `openapi_path_items` ·
`prisma_schema_blocks` · `next_filesystem_routes` · `trpc_procedures` ·
`symfony_yaml_routes` · `embedded_sql_ddl`

Join families use `join_style` (e.g. `nest`, `spring`, `fastapi`, `go_group`,
`raw_node_http`). An unknown `strategy` id fails config load.

Do **not** invent a free-form join DSL in YAML. Add a strategy when the
composition shape is new.

## Coverage notes vs patterns

`routes` / `app_classes` / `models` `status` and `note` fields are human
summaries. Executable coverage is the `source_patterns` list.
