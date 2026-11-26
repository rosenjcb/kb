#!/usr/bin/env bash
# One-command update flow for the Fly.io build-to-serve orchestration: build +
# push the builder image, recreate its daily scheduler (so it picks up the new
# image at the right vm size), ship the serving image, then seed every base now
# instead of waiting for the next daily tick.
#
# Mirrors "Deploying an update" in FLY_ORCHESTRATION.md. Assumes the one-time
# setup already happened (apps, bucket, secrets). If it hasn't — or you just ran
# scripts/fly/teardown.sh — use scripts/fly/bootstrap.sh instead: a cold standup
# needs a different ORDER (serving cannot boot before the first snapshot
# exists), not just a few extra commands.
#
# Usage: scripts/fly/deploy.sh [--no-seed]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SERVE_APP="${SERVE_APP:-kb-demo}"
BUILDER_APP="${BUILDER_APP:-kb-demo-builder}"
SEED=1
[[ "${1:-}" == "--no-seed" ]] && SEED=0

# Region, [[vm]] size/memory, and the whole [env] table come from
# fly.builder.toml — but `fly machine run -c` applies NONE of them, so every
# machine-creating command below has to pass them explicitly or silently get
# Fly's bare platform default (shared-cpu-1x/256mb) and refresh.sh's own
# fallback timeouts. They used to be hand-copied here and in
# .github/workflows/fly-deploy.yml, and drifted twice (shared-cpu-2x/4096 vs
# performance-2x/4096 — cold builds OOM-killed on whichever path ran; and the
# docs still quoting performance-2x/4096 long after this script moved on).
# scripts/fly/builder-args.mjs parses them out of the toml instead, and
# hard-fails if fly.builder.toml and fly.toml disagree on primary_region (a
# cross-region builder makes Tigris hand the serving node a stale LIST view of
# the prefix it just published — observed: scheduler in `lax`, serving in
# `iad`).
mapfile -t BUILDER_ARGS < <(node scripts/fly/builder-args.mjs)
echo "==> builder machine args: ${BUILDER_ARGS[*]}"

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
# A scheduled machine pins its image, vm size, AND env at creation time, so
# recreating it is the only way it picks any of them up. BUILDER_ARGS carries
# all three from the toml (see the note at the top).
fly machine run . -c fly.builder.toml -a "$BUILDER_APP" --detach \
    "${BUILDER_ARGS[@]}" \
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
      "${BUILDER_ARGS[@]}" \
      bash /app/scripts/fly/refresh.sh
  fly logs -a "$BUILDER_APP"
else
  echo "==> 4/4 skipped (--no-seed) — bases populate on the next daily tick"
fi

echo "==> done. Verify: curl -s https://${SERVE_APP}.fly.dev/healthz | jq"
