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
| FR-4 | The snapshot download never depends on `ListObjectsV2` to find the required objects: when the listing comes back short, the manifest is fetched by its fixed key and the index files it names in `contents.index` are fetched by exact key. Only a prefix unreadable by both LIST and direct GET fails the pull |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-SKQD | FR-1 | passes when kb source is bumped and no changeset remains | pass |
| TC-Z33L | FR-1 | fails when kb source changed but the version was not bumped | pass |
| TC-7PSN | FR-1 | fails when a pending changeset has not been applied | pass |
| TC-L3FW | FR-1 | requires only the affected package to bump (kb-server untouched) | pass |
| TC-0KJN | FR-1 | fails when kb-server source changed without a kb-server bump | pass |
| TC-VFJR | FR-1 | allows kb and kb-server to bump independently in one PR | pass |
| TC-FATW | FR-1 | passes for docs/config-only PRs with no bump | pass |
| TC-XZPA | FR-1 | passes when only http test-collection files change under packages/kb-server | pass |
| TC-R48C | FR-1 | fails when more than one changeset is pending | pass |
| TC-HDMF | FR-1 | fails when the version jumped more than one step | pass |
| TC-AMPS | FR-1 | passes for a patch bump (exactly one step) | pass |
| TC-1SML | FR-1 | passes for a major bump (exactly one step) | pass |
| TC-CXSH | FR-1 | fails when minor bumped but patch not reset | pass |
| TC-9M05 | FR-1 | fails when the version was downgraded | pass |
| TC-8MHD | FR-2 | parses major-only specs | pass |
| TC-PXW4 | FR-2 | parses major.minor.patch specs | pass |
| TC-TO0Z | FR-2 | returns [0,0,0] for unrecognized specs | pass |
| TC-MAQ8 | FR-1 | passes for a single major step from pre-1.0 | pass |
| TC-JD07 | FR-2 | accepts equal versions | pass |
| TC-68DG | FR-2 | accepts newer major | pass |
| TC-TTTS | FR-2 | accepts newer minor on same major | pass |
| TC-Q16O | FR-2 | rejects older major | pass |
| TC-YYB3 | FR-2 | rejects older patch when major/minor match | pass |
| TC-O6GZ | FR-2 | passes when engines.node is absent | pass |
| TC-NS54 | FR-2 | passes when current version meets minimum | pass |
| TC-43DY | FR-2 | fails when current version is below minimum | pass |
| TC-2KYE | FR-2 | includes nvm/fnm hints when .nvmrc is present | pass |
| TC-20SV | FR-2 | falls back to generic install hint without .nvmrc | pass |
| TC-GC0O | FR-2 | returns 0 when package.json has no engines.node | pass |
| TC-TSPK | FR-2 | returns 0 when current version satisfies engines.node | pass |
| TC-1D6Z | FR-2 | returns 1 and prints nvm hints when version is too old | pass |
| TC-BECU | FR-3 | defaults to the manifest default base | pass |
| TC-NRO2 | FR-3 | accepts --suite as an alias of --base and dedupes | pass |
| TC-39TL | FR-3 | --all expands to every base in the manifest | pass |
| TC-DAQN | FR-3 | rejects a base the manifest never publishes | pass |
| TC-25UV | FR-3 | rejects --into when several bases are pulled | pass |
| TC-BWRH | FR-3 | rejects unknown flags instead of ignoring them | pass |
| TC-40BM | FR-3 | maps a fly base to the eval-<base> session and its object prefix | pass |
| TC-5LW0 | FR-3 | reads the version out of a latest.json pointer | pass |
| TC-F7B9 | FR-3 | parses keys, common prefixes and truncation from ListObjectsV2 XML | pass |
| TC-USTN | FR-3 | treats an untruncated listing as the final page | pass |
| TC-AO9G | FR-3 | keeps path separators literal and escapes the rest of a key | pass |
| TC-X75S | FR-3 | canonicalizes query parameters in sorted, encoded form | pass |
| TC-78IA | FR-3 | signs a GET deterministically for a fixed clock and credentials | pass |
| TC-4VSL | FR-3 | binds the signature to the object key | pass |
| TC-9TCW | FR-3 | signs the security token header when the credentials are temporary | pass |
| TC-U1VZ | FR-3 | appends the canonical query string to the request URL | pass |
| TC-0EWN | FR-3 | prefers explicit bucket credentials from the environment | pass |
| TC-EGPX | FR-3 | returns null when the environment is missing a required credential | pass |
| TC-BTLZ | FR-3 | reads Tigris keys from the Fly extension listing | pass |
| TC-UDYL | FR-3 | explains how to supply credentials when none are available | pass |
| TC-JRHB | FR-3 | fails loudly when the Fly token yields no storage extension | pass |
| TC-NLON | FR-3 | ignores extensions that are not the requested bucket | pass |
| TC-MAIK | FR-3 | imports into an empty base without forcing | pass |
| TC-P69G | FR-3 | skips the import when the base already holds this snapshot | pass |
| TC-GSHR | FR-3 | replaces an older snapshot automatically | pass |
| TC-88BA | FR-3 | refuses to clobber a locally built index without --force | pass |
| TC-QSZ4 | FR-3 | clobbers a locally built index when --force is given | pass |
| TC-7B2Z | FR-3 | treats a prefix missing a required file as incomplete | pass |
| TC-WXE8 | FR-3 | matches a reference SigV4 implementation byte for byte | pass |
| TC-TUAB | FR-3 | asks Fly only for AddOn fields that exist in the schema | pass |
| TC-LGQL | FR-3 | distinguishes a redacted add-on environment from a missing bucket | pass |
| TC-WM7M | FR-3 | falls back to the org listing when the app has no add-ons | pass |
| TC-ONWZ | FR-4 | recovers a prefix whose LIST is empty but whose objects all GET | pass |
| TC-5Y6Q | FR-4 | recovers a partial LIST that omits the manifest | pass |
| TC-NZ5T | FR-4 | leaves a healthy LIST alone and still pulls aux objects | pass |
| TC-NM9Q | FR-4 | still fails when the prefix is absent by LIST and by GET | pass |
| TC-4F47 | FR-4 | takes index file names from the manifest, always including the primary | pass |

### Related docs

- [INSTALL.md](INSTALL.md)
