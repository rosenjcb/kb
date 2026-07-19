#!/usr/bin/env bash
# One-command update flow for the Fly.io build-to-serve orchestration: ship the
# builder image, recreate its daily scheduler (so it picks up the new image +
# vm size from fly.builder.toml), ship the serving image, then seed every base
# now instead of waiting for the next daily tick.
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

echo "==> 1/4 deploying builder image ($BUILDER_APP)"
fly deploy -a "$BUILDER_APP" -c fly.builder.toml

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
# --vm-memory/--vm-size deliberately omitted: shared-cpu-2x/4096mb comes from
# fly.builder.toml's [[vm]] block via -c.
fly machine run . -c fly.builder.toml -a "$BUILDER_APP" \
    --schedule daily --restart no \
    bash /app/scripts/fly/refresh.sh

echo "==> 3/4 deploying serving image ($SERVE_APP)"
fly deploy -a "$SERVE_APP" -c fly.toml

if [[ "$SEED" -eq 1 ]]; then
  echo "==> 4/4 seeding every base now (skip with --no-seed)"
  fly machine run . -c fly.builder.toml -a "$BUILDER_APP" --rm \
      bash /app/scripts/fly/refresh.sh
  fly logs -a "$BUILDER_APP"
else
  echo "==> 4/4 skipped (--no-seed) — bases populate on the next daily tick"
fi

echo "==> done. Verify: curl -s https://${SERVE_APP}.fly.dev/healthz | jq"
