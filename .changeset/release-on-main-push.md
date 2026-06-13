---
"kb": patch
---

Restore a GitHub release on every push to `main`. Releases are now named after the current Changesets-managed version (e.g. `KB CLI v0.2.0 (build abc1234)`) and include the latest changeset notes from `CHANGELOG.md` in the body. Also fixes the release artifact name mismatch (`node22` → `node24`) that broke the `install-kb.sh` bootstrap installer.
