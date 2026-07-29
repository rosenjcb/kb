# Research: language-agnostic infra ecosystem

Scope declaration for `ecosystems/infra.yaml`. Inference for implemented
sections is in `ecosystem-harvesters.ts`; planned sections are reviewable
coverage only until wired.

## Goal

Answer “what deployable things does this repo declare?” from ops manifests —
no LLM, no network — alongside per-language package harvest (tier-1 in
`NOMENCLATURE_INDEX_PLAN.md` §4a).

## Implemented today

| Source | Signal | Kind | Confidence |
|--------|--------|------|------------|
| `docker-compose.y{a,}ml` / `compose.yaml` | top-level `services` keys | service | 0.85 |
| `fly.toml` | `app = "…"` | service | 0.85 |
| `catalog-info.yaml` | `metadata.name` + Backstage `kind` map | service/api/domain | 0.95 |

Compose also covers the Docker Compose side of “Dockerfile / docker-compose”;
standalone `Dockerfile` has no reliable product name in most trees.

## Planned — high signal

### Kubernetes (+ Kustomize)

- **Files:** k8s YAML (multi-doc), `kustomization.yaml`.
- **Extract:** `metadata.name` on `Deployment` / `Service` / `Ingress` only.
- **Skip:** Helm-templated `{{ }}` files; YAML without `apiVersion`/`kind`.
- **Why:** Ubiquitous deploy identity; names match what operators and Backstage
  already use. Confidence ~0.85.

### Helm `Chart.yaml`

- **Extract:** top-level `name`.
- **Skip:** `templates/` rendering; do not invent Release.Name.
- **Why:** Chart name is the package identity for the chart; often equals the
  service. Confidence ~0.8.

### Procfile

- **Extract:** process type keys (`web`, `worker`, …) via `^name:`.
- **Why:** Heroku-family process roles are real deploy atoms; slightly weaker
  than compose/k8s because `web` is generic. Confidence ~0.7.
- Cross-ref: `bash.yaml` notes process names may surface via Procfile later.

## Planned — careful / optional

### Dockerfile (standalone)

Weak `LABEL` / `ARG` name signals only. Prefer compose service keys. Confidence
cap ~0.4 so registry merge does not promote unlabeled images over package names.

### Terraform

**Planned only, low priority.** Resource addresses (`aws_ecs_service.foo`) are
infra inventory, not product nomenclature — harvesting all of them would flood
the entity graph. If ever implemented: restrict to explicit name-like
`output`/`variable`/`locals` (or tagged service modules), never every
`resource` block. Confidence ceiling ~0.35. Prefer Fly / Backstage / k8s /
compose when present.

### systemd units (optional)

Basename of `*.service` → candidate. Optional because example units and
unrelated vendor units are common. Confidence ~0.55. Defer until k8s/Helm/
Procfile land.

## Deferred (not declared as targets)

| Ecosystem | Verdict |
|-----------|---------|
| **Nomad** | Job `name` is high signal when present, but rare in app repos vs compose/k8s. Revisit if harvest corpus shows density. |
| **CloudFormation** | Logical IDs / stack names are noisy; SAM/CDK app names might be worth a later pass, not CFN raw. |

## Non-goals

- Route / HTTP path harvest from infra YAML (`routes: not_applicable`).
- Promoting code symbols from manifests (`symbols: not_applicable`).
- Parsing Helm/Kustomize template expansion or `terraform plan` state.
- Joining compose build context → package.json (infra↔package merge) — separate
  registry concern once candidates exist.

## Implementation order (suggested)

1. Kubernetes Deployment/Service/Ingress `metadata.name`
2. Helm `Chart.yaml` `name`
3. Procfile process types
4. Dockerfile weak labels (only if false-negative rate justifies)
5. systemd (optional)
6. Terraform (only with a narrow allowlist of name attributes)

## Loader note

`loadInfraEcosystemConfig()` currently requires and wires `compose` / `fly` /
`backstage` only. Extra YAML keys (planned sections, `deferred`) are ignored at
runtime until TypeScript is extended — safe to expand YAML ahead of inference.
