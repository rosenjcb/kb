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

# kb-demo-builder's [[vm]] size in fly.builder.toml (see there for why 4GB).
# `fly machine run -c fly.builder.toml` does NOT inherit this block — it must
# be passed explicitly on every machine-creating command below, or you silently
# get Fly's bare platform default (shared-cpu-1x/256mb).
BUILDER_VM_SIZE="performance-2x"
BUILDER_VM_MEMORY="4096"

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
fly machine run . -c fly.builder.toml -a "$BUILDER_APP" --detach \
    --vm-size "$BUILDER_VM_SIZE" --vm-memory "$BUILDER_VM_MEMORY" \
    --schedule daily --restart no \
    bash /app/scripts/fly/refresh.sh

echo "==> 3/4 deploying serving image ($SERVE_APP)"
fly deploy -a "$SERVE_APP" -c fly.toml

if [[ "$SEED" -eq 1 ]]; then
  echo "==> 4/4 seeding every base now (skip with --no-seed)"
  fly machine run . -c fly.builder.toml -a "$BUILDER_APP" --rm \
      --vm-size "$BUILDER_VM_SIZE" --vm-memory "$BUILDER_VM_MEMORY" \
      bash /app/scripts/fly/refresh.sh
  fly logs -a "$BUILDER_APP"
else
  echo "==> 4/4 skipped (--no-seed) — bases populate on the next daily tick"
fi

echo "==> done. Verify: curl -s https://${SERVE_APP}.fly.dev/healthz | jq"
