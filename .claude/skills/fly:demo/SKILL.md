---
name: fly:demo
description: "Is the user asking me to stand up, tear down, redeploy, reindex, inspect, or cost-check the kb-demo chat demo on Fly.io (kb-demo + kb-demo-builder, https://kb-demo.fly.dev)? Covers the full lifecycle — one-command cold standup, complete teardown with a verified zero bill, shipping a code update, forcing an index refresh, and checking what is currently running — both locally via scripts/fly/*.sh and remotely via the fly-lifecycle GitHub workflow."
---

# Fly demo lifecycle

Operate the public chat demo: **`kb-demo`** (serving) + **`kb-demo-builder`** (daily
index builder), backed by snapshots in Tigris object storage.

Architecture narrative: `FLY_ORCHESTRATION.md`. Behavioral spec:
`scripts/fly/FLY.spec.md`. This skill is the operator's path through them.

## First: establish the environment (every shell, every time)

Tool calls do not persist shell state, and two of these are silent failure modes.

```bash
export PATH="$HOME/.fly/bin:$PATH"        # flyctl is NOT on PATH by default
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
```

- `command -v flyctl` returning nothing is **not** evidence flyctl is missing.
- `node` must be on PATH: every script reads the builder's machine config through
  `scripts/fly/builder-args.mjs`. Without node the scripts abort by design
  (they used to create a `shared-cpu-1x`/256MB machine in the wrong region instead).
- **The scripts are bash 3.2-safe on purpose.** macOS ships bash 3.2; `mapfile`
  is bash 4+. Do not reintroduce it.

## Pick the right operation

| The user wants | Do this | Takes |
|---|---|---|
| "is it up?", "what's running?" | **Status** below | seconds |
| ship a code change to a live demo | `scripts/fly/deploy.sh` | ~10 min |
| refresh the index **now**, off-schedule | **Force a refresh** below | ~5-30 min |
| stand it up when the apps **don't exist** | `scripts/fly/bootstrap.sh` | ~30 min |
| destroy everything, stop all billing | `scripts/fly/teardown.sh` | ~2 min |

`deploy.sh` and `bootstrap.sh` are **not** interchangeable. A cold standup differs
in its *order*, not just in having extra steps — see Traps.

## Status

```bash
curl -sS https://kb-demo.fly.dev/healthz                      # ok:true when serving
curl -sS https://kb-demo.fly.dev/v1/bases | jq '.bases[].name'
fly machine list -a kb-demo            # serving machines (expect 2)
fly machine list -a kb-demo-builder    # the scheduler, stopped between runs
fly logs -a kb-demo-builder            # last builder run
```

Reading the output:

- **`/v1/bases` counts that disagree between calls** are normal right after a
  restart: the default base binds the port first, the other nine import in the
  background, and the load balancer hits two machines at different stages.
- **A builder machine with no `--schedule`** is a leftover one-off run, not the
  scheduler. If that is the *only* machine, **nothing is refreshing the index.**
- **The demo stays healthy when the builder fails.** Serving is frozen
  (`--bootstrap-policy snapshot-only`: no git, no reindex), so a broken builder
  means stale data served cheerfully and silently. Check builder logs before
  concluding all is well.

## Stand up (apps do not exist)

```bash
GEMINI_API_KEY=... scripts/fly/bootstrap.sh          # full cold standup
GEMINI_API_KEY=... scripts/fly/bootstrap.sh --no-seed  # provision only
```

The key is usually already exported in the operator's shell — check before asking
for it. Do **not** try to read it off the Fly app: Fly secrets are write-only
(`fly secrets list` shows a digest, never a value).

`--no-seed` leaves the demo **down** until the first builder run, because serving
cannot boot without a snapshot. Only use it when that is understood.

## Tear down (destroys everything, including snapshots)

```bash
scripts/fly/teardown.sh          # prompts for the app name
scripts/fly/teardown.sh --yes    # unattended
```

It ends by **verifying** the bill is zero — re-lists apps, machines, volumes, the
bucket, and any stray `fly-builder-*` remote-builder app — and exits non-zero if
anything survived. A green run means nothing is billing, not merely that the
commands ran.

`--keep-bucket` is almost always wrong: the bucket's credentials die with the
apps and cannot be recovered, so a kept bucket is a bill, not a backup.

## Run it from GitHub instead

Requires secrets `FLY_API_TOKEN_ORG` (org-scoped — app-scoped tokens cannot
create or destroy apps) and, for standup, `GEMINI_API_KEY`.

```bash
gh workflow run fly-lifecycle.yml -f action=stand-up -f seed=true
gh workflow run fly-lifecycle.yml -f action=tear-down -f confirm=DESTROY
gh run watch "$(gh run list --workflow=fly-lifecycle.yml -L1 --json databaseId --jq '.[0].databaseId')"
```

`workflow_dispatch` only appears once the workflow is on the **default branch**.

## Ship a code update (apps already exist)

```bash
scripts/fly/deploy.sh             # builder image + scheduler + serving + reseed
scripts/fly/deploy.sh --no-seed   # skip the immediate reindex
```

Pushing to `main` under `packages/**`, `Dockerfile.fly`, `fly*.toml`, or
`scripts/fly/**` does the same via `.github/workflows/fly-deploy.yml` — except
the CI builder job only *recreates the scheduler*; it does not reindex. **Pushing
to main never rebuilds the index.**

## Force a refresh now

```bash
BUILDER_ARGS=()
while IFS= read -r l; do BUILDER_ARGS+=("$l"); done < <(node scripts/fly/builder-args.mjs)
fly machine run . -c fly.builder.toml -a kb-demo-builder --rm \
    "${BUILDER_ARGS[@]}" bash /app/scripts/fly/refresh.sh
```

Scope it with `ONLY_BASES=kb,raylib` or force a full rebuild with `FORCE_COLD=true`
(pass as `-e`). Never hand-write `--region`/`--vm-size`: always source them from
`builder-args.mjs`.

## Traps — each of these has cost real time

1. **Serving cannot be deployed before a snapshot exists.** `snapshot-only` boot
   *fails the release* on an empty bucket; it does not come up degraded and
   backfill. Seed first. This is why bootstrap's order is load-bearing.
2. **The seed cannot roll a serving app with no machines.** `roll-serving.mjs`
   exits non-zero on "no started serving machines found", so bootstrap sets
   `SERVE_APP`/`FLY_API_TOKEN` on the builder *after* the serving deploy.
3. **Tigris credentials print once and are then unrecoverable.** Nothing reads
   them back — no `fly storage` subcommand, no credential flag on `fly storage
   update`, and the addon's GraphQL `environment` returns `{}`. Fly also allows
   one Tigris project per app, so a second `fly storage create --app X` fails
   even under a new bucket name. Lost keys ⇒ new bucket (`--bucket <name>`).
4. **Builder and serving must share a region.** Cross-region, Tigris returns a
   stale LIST of a fresh prefix — every key head-objects 200 while
   `s3 cp --recursive` copies nothing — and the node crash-loops on "downloaded
   prefix … is incomplete". `builder-args.mjs` hard-fails on a mismatch.
5. **CI's deploy tokens are app-scoped and die with their app.** After any
   teardown/standup cycle, `fly-deploy.yml` fails with an auth error even though
   the demo is healthy. Remint both `FLY_API_TOKEN_KB_DEMO*` secrets.

## Cost, for advising the user

- Serving node, always-warm: **~$6.70/mo** — effectively the entire bill.
- Daily builder run: ~**$0.13/mo** at `performance-1x`/2048MB.
- A full cold seed: ~**$0.03** of compute, ~30 min, and **a full re-embed of all
  10 bases against the Gemini quota** — that last one is the real cost, and it is
  exhaustible.

So teardown is worth it for parking the demo **for weeks**, not overnight: a
nightly cycle burns the quota and 30 minutes to save ~22¢. If the user wants
cheap overnight parking, suggest scaling serving to zero machines instead —
apps, bucket, and snapshots survive and it restarts in under a minute.

## Do not

- Do not create a builder machine without `builder-args.mjs`'s flags.
- Do not run `deploy.sh` when the apps do not exist, or `bootstrap.sh` when they do.
- Do not print a Fly deploy token or API key into output.
- Do not destroy the bucket while intending to reuse its snapshots.
