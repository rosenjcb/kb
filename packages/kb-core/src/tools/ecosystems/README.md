# Ecosystem harvester coverage YAML
#
# One file per language (plus `infra.yaml` for language-agnostic deploy manifests).
# These files are the reviewable scope of what we harvest; inference code lives in
# `ecosystem-harvesters.ts` / `ecosystem-config.ts`.
#
# Top-level `status`:
#   implemented     — harvest cycle reads this file and emits entities
#   planned         — coverage declared; inference not wired yet
#   not_applicable  — no package/deploy ecosystem (css/html/bash)
#
# `research/` holds optional rationale notes from research agents. Not loaded at runtime.

# Implemented harvest: typescript, go, python, rust, php, infra
# Planned harvest: ruby, java, csharp, scala, haskell, cpp (+ infra k8s/helm/procfile)
# N/A: css, html, bash
