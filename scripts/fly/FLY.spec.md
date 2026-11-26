---
type: Spec
title: "Spec: Fly build-to-serve orchestration"
sources:
  - ./lib.sh
  - ./serve-entrypoint.sh
  - ./refresh.sh
  - ./deploy.sh
  - ./bootstrap.sh
  - ./teardown.sh
  - ./builder-args.mjs
  - ../../.github/workflows/fly-lifecycle.yml
  - ./roll-serving.mjs
  - ../../fly.toml
  - ../../fly.builder.toml
  - ../../.github/workflows/fly-deploy.yml
  - ../../FLY_ORCHESTRATION.md
tests:
  - ../../tests/fly/fly-orchestration.test.ts
description: >-
  Corruption-safe multi-base snapshot publish/adopt for kb-demo on Fly.io,
  including region co-location and incomplete-prefix recovery.
tags: [fly, snapshots, ops, build-to-serve]
timestamp: 2026-08-01T23:20:00Z
---

### Intro

The Fly demo splits **build** (`kb-demo-builder`) from **serve** (`kb-demo`).
The builder publishes per-base immutable snapshot prefixes to Tigris and flips
`latest.json`; the serving node is a pure function of those pointers under
`--bootstrap-policy snapshot-only`. This spec pins the transport and boot
invariants that keep a partial object-store view or a slow multi-base import
from crash-looping the public demo. Architecture narrative:
[FLY_ORCHESTRATION.md](../../FLY_ORCHESTRATION.md) and
[HANDOFF.md](../../packages/kb-server/HANDOFF.md).

### Definitions

- **Snapshot prefix**: Immutable object-store directory
  `snapshots/<base>/<version>/` containing at least `kb-snapshot.json` and
  `.kb-index.sqlite`.
- **Pointer**: `snapshots/<base>/latest.json` — the single commit point naming
  the live `version` (and `indexDigest`).
- **Required objects**: `kb-snapshot.json` and `.kb-index.sqlite` — the minimum
  set that must be readable before a prefix is considered publishable or
  adoptable.
- **Short LIST**: A `ListObjectsV2` response that omits objects the same
  credentials can `head-object`/`GET` by exact key. Observed on Tigris whenever
  the reading region differs from the writing region, up to and including an
  *empty* listing for a fully-populated prefix.
- **Default base**: The base named in `bases.json` (`default`) / `KB_BASE`;
  required for the serving process to listen.
- **Optional base**: Any non-default base in `bases.json`; skipped when its
  snapshot is missing or incomplete after retries.

### Scope

## In Scope

- Object-store pull/push completeness checks and retries (`lib.sh`)
- LIST-free recovery of required objects on the adopt path (`lib.sh`)
- Serving boot order: default base first, then optional bases
- Builder publish gate before pointer flip
- Serving ↔ builder region co-location — both the declared `primary_region`
  **and** the region builder machines are actually created in
- Health-gated serving roll timeout headroom

## Out of Scope

- `kb-server refresh` / `import` / sha256 adopt semantics (see
  [SERVER.spec.md](../../packages/kb-server/src/SERVER.spec.md) FR-18)
- Index build quality, embeddings, or LLM answer correctness
- GCP orchestration (`scripts/gcp/`) parity except shared behavioral intent

### Functional Requirements

| ID | Requirement |
|------|-------------|
| FR-1 | [NEW] Serving and builder apps declare the same Fly `primary_region` so snapshot LIST/GET and publish share one region |
| FR-8 | [NEW] Every command that creates a builder machine passes `--region` explicitly, sourced from `fly.builder.toml`'s `primary_region` — `fly machine run -c` does not inherit it, so declaring the region alone does not place the machine |
| FR-14 | [NEW] `fly.builder.toml` is the single source of truth for the builder machine's region, `[[vm]]` size/memory, and `[env]` table; every `fly machine run` caller (`deploy.sh`, `bootstrap.sh`, the CI workflow) obtains all of them from `scripts/fly/builder-args.mjs` and hard-codes none of them |
| FR-15 | [NEW] `builder-args.mjs` exits non-zero when `fly.builder.toml` and `fly.toml` declare different `primary_region` values, rather than emitting flags that would place a cross-region builder (FR-1's invariant, enforced before a machine exists) |
| FR-16 | [NEW] Cold standup order: the first seed publishes at least one snapshot **before** the serving app is deployed (serving pins `--bootstrap-policy snapshot-only` and fails its release on an empty bucket), and the builder's `SERVE_APP`/`FLY_API_TOKEN` roll credentials are set only **after** serving has machines (`roll-serving.mjs` exits non-zero with none) |
| FR-18 | [NEW] Standup and teardown are runnable as a manual GitHub Actions workflow (`fly-lifecycle.yml`) that delegates to `bootstrap.sh`/`teardown.sh` rather than reimplementing their ordering; teardown requires an explicit confirmation phrase, the two never run concurrently, and neither is cancellable in flight |
| FR-19 | [NEW] Teardown ends by verifying no billable resource survived — the two apps, their machines and volumes, the Tigris bucket, and any leftover `fly-builder-*` remote-builder app — and exits non-zero if any remain |
| FR-17 | [NEW] Teardown destroys the snapshot bucket by default, because Tigris credentials are printed once by `fly storage create` and are unreadable afterwards — a bucket that outlives its apps' secrets cannot be authenticated against |
| FR-9 | [NEW] A snapshot pull that cannot assemble the required objects from the LIST-driven recursive copy refetches them by exact key (manifest at its fixed name, index files named by the manifest's `contents.index`) before failing the attempt |
| FR-2 | [NEW] After uploading an immutable snapshot prefix, the builder does not flip `latest.json` until every required object is readable via head-object (not LIST alone) |
| FR-3 | [NEW] Snapshot pull retries until required objects are present locally (or attempts are exhausted); aws progress must not pollute captured stdout (e.g. version strings) |
| FR-4 | [NEW] Serving boot adopts the default base and binds `/healthz` before importing optional bases |
| FR-5 | [NEW] Optional-base import is best-effort: incomplete/missing snapshots are skipped without exiting the serving process |
| FR-6 | [NEW] A failed or incomplete default-base adopt exits non-zero (no listen on a half-booted node) |
| FR-7 | [NEW] Serving roll waits long enough for default-base adopt + listen under normal Tigris latency (configurable, default ≥ 10 minutes) |
| FR-10 | [NEW] Every `fly machine run` call in `deploy.sh` and the production `fly.toml`/`fly.builder.toml` declares `KB_EMBEDDER=gemini`, so builder and serving apps never fall back to a different embedder |
| FR-11 | [NEW] `refresh.sh` iterates bases fail-fast: once a base's refresh fails, later bases in the loop do not run and the serving roll is skipped; a failure mid-embed for a base must not flip that base's S3 `latest.json` pointer |
| FR-12 | [NEW] `build_base` honors `FORCE_COLD=true` by ignoring `latest.json` and rebuilding cold |
| FR-13 | [NEW] The builder's `ONLY_BASES` env var restricts base iteration to the listed names only |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|---------|------------------|
| TC-D98R | FR-1 | `fly.toml` and `fly.builder.toml` `primary_region` compared | Identical region string (currently `iad`) |
| TC-PDQD | FR-8, FR-14 | `deploy.sh`, `bootstrap.sh`, and the workflow's recreate-scheduler step inspected for `fly machine run` calls | Every call forwards `builder-args.mjs`'s output; no literal `--region`/`--vm-size` anywhere in the three callers |
| TC-4JKB | FR-8 | `fly machine list -a kb-demo-builder` after a deploy | Scheduler machine's region equals `fly.toml`'s `primary_region` |
| TC-WQ3F | FR-14 | `builder-args.mjs` executed in the repo root | Emits `--region` matching the toml, a `--vm-size`/`--vm-memory` pair, and one `-e KEY=VALUE` for **every** key in the toml's `[env]` table |
| TC-K2QW | FR-14 | `deploy.sh`, `bootstrap.sh`, and the workflow inspected for how they read the shim's output | None calls `mapfile` (bash 4+; macOS ships bash 3.2, where it fails and leaves the array empty, silently yielding a `shared-cpu-1x`/256MB machine in the caller's region); each uses a `while IFS= read` loop and aborts when the shim yields no arguments |
| TC-M8ZK | FR-15 | `builder-args.mjs` run against a fixture whose two tomls declare `iad` and `lax` | Exits non-zero naming the region mismatch; emits no flags |
| TC-T41C | FR-16 | `bootstrap.sh` step order inspected | The cold seed precedes `fly deploy -a $SERVE_APP`, and `fly tokens create deploy` / the `SERVE_APP` secret follow it |
| TC-3VPL | FR-18 | `fly-lifecycle.yml` inspected | Has `workflow_dispatch` with a `stand-up`/`tear-down` choice, gates teardown on `confirm == DESTROY`, calls `bootstrap.sh`/`teardown.sh`, and sets `cancel-in-progress: false` on a shared concurrency group |
| TC-7BQN | FR-19 | `teardown.sh` run to completion | Reports each app, bucket, and `fly-builder-*` app as gone, and exits non-zero if any survived |
| TC-9XBD | FR-17 | `teardown.sh` inspected with no flags | Destroys the Tigris bucket (`KEEP_BUCKET=0` default) and warns that CI's app-scoped `FLY_API_TOKEN_*` secrets are now dead |
| TC-IHL1 | FR-9 | Prefix whose LIST returns empty while every required key head-objects 200 | Recursive copy comes back empty, required objects are refetched by key, pull returns 0 with both files local |
| TC-OUBI | FR-9 | Prefix that is genuinely absent (keys neither LIST-able nor GET-able) | Both paths fail every attempt; pull returns non-zero (no false success) |
| TC-MHQN | FR-9 | `pull_latest`/`s3_pull_prefix` retry/refetch path inspected | `lib.sh` implements the retry-then-refetch-by-key sequence |
| TC-E9O4 | FR-10, FR-14 | `KB_EMBEDDER` as delivered to a builder machine | `builder-args.mjs` emits `-e KB_EMBEDDER=gemini` from the toml's `[env]`, so every caller sets it without repeating it |
| TC-ROM5 | FR-10 | Production `fly.toml` and `fly.builder.toml` inspected | Both the builder and serve app declare `KB_EMBEDDER=gemini` |
| TC-SH7G | FR-11 | `refresh.sh` fail-fast loop when a base fails | Later bases in the loop do not run and the roll is skipped |
| TC-RM3X | FR-11 | `refresh.sh` fail-fast loop when a base fails | Same failure short-circuits the loop (paired assertion with TC-SH7G) |
| TC-HT27 | FR-11 | A base's refresh fails mid-embed | That base's S3 `latest.json` pointer is not flipped |
| TC-P06Z | FR-12 | `build_base` runs with `FORCE_COLD=true` | `latest.json` is ignored; base rebuilds cold |
| TC-63GA | FR-13 | Builder iterates bases with `ONLY_BASES` set | Only the listed base names run |
| TC-U5RT | FR-2 | Upload succeeds but `kb-snapshot.json` never becomes head-able within wait budget | `s3_push_prefix` fails; pointer not written |
| TC-QMFK | FR-2 | Upload of a complete local snapshot dir | Required objects head-able; caller may flip `latest.json` |
| TC-8KCV | FR-3 | Pull of a prefix that temporarily LIST/GETs only `.kb-index.sqlite` | Retries; success only once `kb-snapshot.json` is local too, else non-zero |
| TC-2PNL | FR-3 | `version="$(pull_latest …)"` around a multi-file pull | Captured value is the version token only (no aws progress text) |
| TC-VJML | FR-4 | Serving boot with default + large optional bases | `/healthz` reports `ok:true` after default import/start, before optional imports finish |
| TC-B5JP | FR-5 | Optional base pointer exists but prefix stays incomplete after retries | Base skipped; process continues; default still served |
| TC-UNIF | FR-6 | Default base pointer missing or prefix incomplete after retries | Entrypoint exits non-zero; nothing binds `:PORT` |
| TC-4KB9 | FR-7 | Builder finishes publish and rolls one serving machine | Roll does not fail solely because optional-base downloads are still in flight |

### Known issues

- GCP `scripts/gcp/lib.sh` does not yet share the head-object completeness
  helpers; parity is intentional follow-up, not in this change.
