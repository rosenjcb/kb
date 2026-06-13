# Changesets

This directory contains changeset files used to track version bumps and changelog entries.

## Workflow

1. Make your changes on a feature branch.
2. Run `pnpm changeset` and follow the prompts to describe your change and select a semver bump type (patch / minor / major).
3. Commit the generated `.changeset/<name>.md` file alongside your code changes.
4. Open a PR — CI will fail if no changeset file is present.
5. When your PR is merged to `main`, the Changesets GitHub Action automatically opens a "Version Packages" PR that aggregates all pending changesets into a version bump + CHANGELOG update.
6. Merging the "Version Packages" PR triggers the release workflow: it creates a git tag, builds the CLI artifact, and publishes a tagged `v*.*.*` GitHub release.

> **Note:** Every push to `main` also publishes a rolling build release named after the current (Changesets-managed) version, e.g. `KB CLI v0.2.0 (build abc1234)`, with the latest changeset notes in the body. This keeps `releases/latest` continuously up to date between version bumps.

## Bump types

| Type    | When to use |
|---------|-------------|
| `patch` | Bug fixes, docs, internal refactors with no behaviour change |
| `minor` | New features or capabilities added in a backwards-compatible way |
| `major` | Breaking changes to the CLI interface, config format, or public APIs |
