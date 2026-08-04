#!/usr/bin/env bash
# One-command update flow for the Fly.io build-to-serve orchestration: build +
# push the builder image, recreate its daily scheduler (so it picks up the new
# image at the right vm size), ship the serving image, then seed every base now
# instead of waiting for the next daily tick.
#
# Mirrors "Deploying an update" in FLY_ORCHESTRATION.md. Assumes the one-time
# setup already happened (fly apps create, fly storage create, secrets) — see
# that doc's "One-time setup" section if it hasn't.
#
# Usage: scripts/fly/deploy.sh [--no-seed]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SERVE_APP="${SERVE_APP:-kb-demo}"
BUILDER_APP="${BUILDER_APP:-kb-demo-builder}"
SEED=1
[[ "${1:-}" == "--no-seed" ]] && SEED=0

# kb-demo-builder's [[vm]] size in fly.builder.toml (see there for why 8GB).
# `fly machine run -c fly.builder.toml` does NOT inherit this block — it must
# be passed explicitly on every machine-creating command below, or you silently
# get Fly's bare platform default (shared-cpu-1x/256mb). Keep this in sync with
# fly.builder.toml AND .github/workflows/fly-deploy.yml's recreate-scheduler
# step — they drifted apart once already (shared-cpu-2x/4096 vs
# performance-2x/4096) and cold builds got OOM-killed on whichever one a given
# path actually used.
BUILDER_VM_SIZE="performance-4x"
BUILDER_VM_MEMORY="8192"

# Same non-inheritance trap as [[vm]] and [env] below: `fly machine run -c
# fly.builder.toml` does NOT honor the file's `primary_region` either — it
# places the machine near whoever ran the command (a laptop, or a GitHub
# runner). That is not cosmetic: builder and serving MUST share a region or
# Tigris serves the serving node a stale LIST view of a freshly published
# prefix — head-object 200s on every key while `aws s3 cp --recursive` copies
# nothing, and the demo crash-loops on "downloaded prefix … is incomplete".
# Observed for real: the scheduler landed in `lax`, serving stayed in `iad`.
# Read it from the toml instead of hard-coding a copy that can drift.
BUILDER_REGION="$(node -e '
  const fs = require("fs");
  const m = fs.readFileSync("fly.builder.toml", "utf8").match(/^\s*primary_region\s*=\s*"([^"]+)"/m);
  process.stdout.write(m ? m[1] : "");
')"
if [[ -z "$BUILDER_REGION" ]]; then
  echo "error: could not read primary_region from fly.builder.toml." >&2
  exit 1
fi
echo "==> builder region pinned to '$BUILDER_REGION' (must match fly.toml's primary_region)"

echo "==> 1/4 building + pushing builder image ($BUILDER_APP)"
# --build-only --push: build and push the image WITHOUT deploying/releasing it.
# A plain `fly deploy` on an app with no [processes]/[http_service] still
# creates/replaces a running machine using the image's default CMD
# (serve-entrypoint.sh) — which clobbers the scheduled machine's custom
# --schedule/--restart/cmd. Building only avoids that entirely.
fly deploy -a "$BUILDER_APP" -c fly.builder.toml --build-only --push

echo "==> 2/4 recreating the daily scheduler machine"
# kb-demo-builder runs exactly one machine (the scheduled one) between deploys.
scheduler_id="$(fly machine list -a "$BUILDER_APP" --json | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const m = JSON.parse(s || "[]");
    process.stdout.write((m[0] && m[0].id) || "");
  });
')"
if [[ -n "$scheduler_id" ]]; then
  echo "    destroying old scheduler $scheduler_id"
  fly machine destroy "$scheduler_id" -a "$BUILDER_APP" --force
else
  echo "    no existing scheduler found; creating one"
fi
# -e COLD_BUILD_TIMEOUT: same non-inheritance problem as [[vm]] above —
# `fly machine run -c fly.builder.toml` does NOT apply fly.builder.toml's
# [env] block either. Without this, refresh.sh silently falls back to its
# own 1800s default instead of the 5400s the toml declares, and the biggest
# cold builds (brew, kestra) get killed as a false "timeout" well before
# they'd actually finish.
fly machine run . -c fly.builder.toml -a "$BUILDER_APP" --detach \
    --region "$BUILDER_REGION" \
    --vm-size "$BUILDER_VM_SIZE" --vm-memory "$BUILDER_VM_MEMORY" \
    -e COLD_BUILD_TIMEOUT=5400 \
    --schedule daily --restart no \
    bash /app/scripts/fly/refresh.sh

echo "==> 3/4 deploying serving image ($SERVE_APP)"
# --wait-timeout: boot now serially imports up to 10 bases before the port
# opens, which can exceed flyctl's 5m default — see fly.toml's [checks.tcp]
# comment.
fly deploy -a "$SERVE_APP" -c fly.toml --wait-timeout 15m

if [[ "$SEED" -eq 1 ]]; then
  echo "==> 4/4 seeding every base now (skip with --no-seed)"
  fly machine run . -c fly.builder.toml -a "$BUILDER_APP" --rm \
      --region "$BUILDER_REGION" \
      --vm-size "$BUILDER_VM_SIZE" --vm-memory "$BUILDER_VM_MEMORY" \
      -e COLD_BUILD_TIMEOUT=5400 \
      bash /app/scripts/fly/refresh.sh
  fly logs -a "$BUILDER_APP"
else
  echo "==> 4/4 skipped (--no-seed) — bases populate on the next daily tick"
fi

echo "==> done. Verify: curl -s https://${SERVE_APP}.fly.dev/healthz | jq"
