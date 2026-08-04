---
type: Spec
title: "Spec: Repo Scripts"
sources: [./]
tests: [../tests/scripts]
description: Behavioral specification for Repo Scripts
tags: [spec, kb]
timestamp: 2026-08-02T23:10:00Z
---

### Intro

Behavioral requirements. Architecture: [INSTALL.md](INSTALL.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- See related companion docs for architectural boundaries

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Changeset consistency gate enforces version bump policy on PRs |
| FR-2 | Node version check enforces engines.node before install |
| FR-3 | Snapshot puller adopts a published Fly.io snapshot locally: resolve base from `scripts/fly/bases.json`, follow `latest.json` to an immutable version, download the prefix with SigV4-signed reads, verify the manifest sha256, then `kb-server import` into `eval-<base>` — refusing to clobber a locally built index without `--force` |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | passes when kb source is bumped and no changeset remains | pass |
| TC-2 | FR-1 | fails when kb source changed but the version was not bumped | pass |
| TC-3 | FR-1 | fails when a pending changeset has not been applied | pass |
| TC-4 | FR-1 | requires only the affected package to bump (kb-server untouched) | pass |
| TC-5 | FR-1 | fails when kb-server source changed without a kb-server bump | pass |
| TC-6 | FR-1 | allows kb and kb-server to bump independently in one PR | pass |
| TC-7 | FR-1 | passes for docs/config-only PRs with no bump | pass |
| TC-8 | FR-1 | passes when only http test-collection files change under packages/kb-server | pass |
| TC-9 | FR-1 | fails when more than one changeset is pending | pass |
| TC-10 | FR-1 | fails when the version jumped more than one step | pass |
| TC-11 | FR-1 | passes for a patch bump (exactly one step) | pass |
| TC-12 | FR-1 | passes for a major bump (exactly one step) | pass |
| TC-13 | FR-1 | fails when minor bumped but patch not reset | pass |
| TC-14 | FR-1 | fails when the version was downgraded | pass |
| TC-15 | FR-2 | parses major-only specs | pass |
| TC-16 | FR-2 | parses major.minor.patch specs | pass |
| TC-17 | FR-2 | returns [0,0,0] for unrecognized specs | pass |
| TC-18 | FR-1 | passes for a single major step from pre-1.0 | pass |
| TC-19 | FR-2 | accepts equal versions | pass |
| TC-20 | FR-2 | accepts newer major | pass |
| TC-21 | FR-2 | accepts newer minor on same major | pass |
| TC-22 | FR-2 | rejects older major | pass |
| TC-23 | FR-2 | rejects older patch when major/minor match | pass |
| TC-24 | FR-2 | passes when engines.node is absent | pass |
| TC-25 | FR-2 | passes when current version meets minimum | pass |
| TC-26 | FR-2 | fails when current version is below minimum | pass |
| TC-27 | FR-2 | includes nvm/fnm hints when .nvmrc is present | pass |
| TC-28 | FR-2 | falls back to generic install hint without .nvmrc | pass |
| TC-29 | FR-2 | returns 0 when package.json has no engines.node | pass |
| TC-30 | FR-2 | returns 0 when current version satisfies engines.node | pass |
| TC-31 | FR-2 | returns 1 and prints nvm hints when version is too old | pass |
| TC-32 | FR-3 | defaults to the manifest default base | pass |
| TC-33 | FR-3 | accepts --suite as an alias of --base and dedupes | pass |
| TC-34 | FR-3 | --all expands to every base in the manifest | pass |
| TC-35 | FR-3 | rejects a base the manifest never publishes | pass |
| TC-36 | FR-3 | rejects --into when several bases are pulled | pass |
| TC-37 | FR-3 | rejects unknown flags instead of ignoring them | pass |
| TC-38 | FR-3 | maps a fly base to the eval-<base> session and its object prefix | pass |
| TC-39 | FR-3 | reads the version out of a latest.json pointer | pass |
| TC-40 | FR-3 | parses keys, common prefixes and truncation from ListObjectsV2 XML | pass |
| TC-41 | FR-3 | treats an untruncated listing as the final page | pass |
| TC-42 | FR-3 | keeps path separators literal and escapes the rest of a key | pass |
| TC-43 | FR-3 | canonicalizes query parameters in sorted, encoded form | pass |
| TC-44 | FR-3 | signs a GET deterministically for a fixed clock and credentials | pass |
| TC-45 | FR-3 | binds the signature to the object key | pass |
| TC-46 | FR-3 | signs the security token header when the credentials are temporary | pass |
| TC-47 | FR-3 | appends the canonical query string to the request URL | pass |
| TC-48 | FR-3 | prefers explicit bucket credentials from the environment | pass |
| TC-49 | FR-3 | returns null when the environment is missing a required credential | pass |
| TC-50 | FR-3 | reads Tigris keys from the Fly extension listing | pass |
| TC-51 | FR-3 | explains how to supply credentials when none are available | pass |
| TC-52 | FR-3 | fails loudly when the Fly token yields no storage extension | pass |
| TC-53 | FR-3 | ignores extensions that are not the requested bucket | pass |
| TC-54 | FR-3 | imports into an empty base without forcing | pass |
| TC-55 | FR-3 | skips the import when the base already holds this snapshot | pass |
| TC-56 | FR-3 | replaces an older snapshot automatically | pass |
| TC-57 | FR-3 | refuses to clobber a locally built index without --force | pass |
| TC-58 | FR-3 | clobbers a locally built index when --force is given | pass |
| TC-59 | FR-3 | treats a prefix missing a required file as incomplete | pass |
| TC-60 | FR-3 | matches a reference SigV4 implementation byte for byte | pass |
| TC-61 | FR-3 | asks Fly only for AddOn fields that exist in the schema | pass |
| TC-62 | FR-3 | distinguishes a redacted add-on environment from a missing bucket | pass |
| TC-63 | FR-3 | falls back to the org listing when the app has no add-ons | pass |

### Related docs

- [INSTALL.md](INSTALL.md)
