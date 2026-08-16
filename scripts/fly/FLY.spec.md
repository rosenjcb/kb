---
type: Spec
title: "Spec: Fly build-to-serve orchestration"
sources:
  - ./lib.sh
  - ./serve-entrypoint.sh
  - ./refresh.sh
  - ./deploy.sh
  - ./roll-serving.mjs
  - ../../fly.toml
  - ../../fly.builder.toml
  - ../../.github/workflows/fly-deploy.yml
  - ../../FLY_ORCHESTRATION.md
tests: []
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
| FR-9 | [NEW] A snapshot pull that cannot assemble the required objects from the LIST-driven recursive copy refetches them by exact key (manifest at its fixed name, index files named by the manifest's `contents.index`) before failing the attempt |
| FR-2 | [NEW] After uploading an immutable snapshot prefix, the builder does not flip `latest.json` until every required object is readable via head-object (not LIST alone) |
| FR-3 | [NEW] Snapshot pull retries until required objects are present locally (or attempts are exhausted); aws progress must not pollute captured stdout (e.g. version strings) |
| FR-4 | [NEW] Serving boot adopts the default base and binds `/healthz` before importing optional bases |
| FR-5 | [NEW] Optional-base import is best-effort: incomplete/missing snapshots are skipped without exiting the serving process |
| FR-6 | [NEW] A failed or incomplete default-base adopt exits non-zero (no listen on a half-booted node) |
| FR-7 | [NEW] Serving roll waits long enough for default-base adopt + listen under normal Tigris latency (configurable, default ≥ 10 minutes) |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|-------------|---------|------------------|
| TC-D98R | FR-1 | `fly.toml` and `fly.builder.toml` `primary_region` compared | Identical region string (currently `iad`) |
| TC-PDQD | FR-8 | `scripts/fly/deploy.sh` and the workflow's recreate-scheduler step inspected for `fly machine run` calls | Every call passes `--region` read from `fly.builder.toml`; no hard-coded second copy of the region |
| TC-4JKB | FR-8 | `fly machine list -a kb-demo-builder` after a deploy | Scheduler machine's region equals `fly.toml`'s `primary_region` |
| TC-IHL1 | FR-9 | Prefix whose LIST returns empty while every required key head-objects 200 | Recursive copy comes back empty, required objects are refetched by key, pull returns 0 with both files local |
| TC-OUBI | FR-9 | Prefix that is genuinely absent (keys neither LIST-able nor GET-able) | Both paths fail every attempt; pull returns non-zero (no false success) |
| TC-U5RT | FR-2 | Upload succeeds but `kb-snapshot.json` never becomes head-able within wait budget | `s3_push_prefix` fails; pointer not written |
| TC-QMFK | FR-2 | Upload of a complete local snapshot dir | Required objects head-able; caller may flip `latest.json` |
| TC-8KCV | FR-3 | Pull of a prefix that temporarily LIST/GETs only `.kb-index.sqlite` | Retries; success only once `kb-snapshot.json` is local too, else non-zero |
| TC-2PNL | FR-3 | `version="$(pull_latest …)"` around a multi-file pull | Captured value is the version token only (no aws progress text) |
| TC-VJML | FR-4 | Serving boot with default + large optional bases | `/healthz` reports `ok:true` after default import/start, before optional imports finish |
| TC-B5JP | FR-5 | Optional base pointer exists but prefix stays incomplete after retries | Base skipped; process continues; default still served |
| TC-UNIF | FR-6 | Default base pointer missing or prefix incomplete after retries | Entrypoint exits non-zero; nothing binds `:PORT` |
| TC-4KB9 | FR-7 | Builder finishes publish and rolls one serving machine | Roll does not fail solely because optional-base downloads are still in flight |

### Known issues

- Automated `[TC-N]` unit coverage for these shell helpers is not yet wired
  (`tests: []`). Acceptance today is ops verification against `kb-demo`
  (`/healthz`, `/v1/bases`) plus the FR/TC table above.
- GCP `scripts/gcp/lib.sh` does not yet share the head-object completeness
  helpers; parity is intentional follow-up, not in this change.
