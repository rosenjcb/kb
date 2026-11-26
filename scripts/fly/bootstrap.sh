#!/usr/bin/env bash
# Stand the whole Fly chat demo up FROM NOTHING: two apps, a Tigris bucket,
# every secret, the image, a full cold seed of all bases, the serving node, and
# the daily scheduler.
#
# This is the inverse of scripts/fly/teardown.sh. Use it when the apps do not
# exist. To ship a code change to a deployment that already exists, use
# scripts/fly/deploy.sh instead — it skips all the one-time provisioning.
#
# THE ORDER HERE IS LOAD-BEARING. Three traps, each of which cost real time:
#
#   1. Serving CANNOT be deployed before the first snapshot exists. fly.toml
#      pins KB_SERVER_BOOTSTRAP_POLICY=snapshot-only, so the serving node's
#      boot downloads a published snapshot and refuses to bind the port without
#      one. On an empty bucket `fly deploy -a kb-demo` therefore fails the
#      release (it does not come up degraded and backfill later). The seed must
#      run first. The old documented order deployed serving at step 2, before
#      the builder image even existed.
#
#   2. The seed's final step rolls the serving app, which fails when serving has
#      no machines yet ("no started serving machines found"). So SERVE_APP and
#      FLY_API_TOKEN are deliberately set on the builder AFTER the seed — with
#      them unset, refresh.sh logs "skipping serving roll" and exits 0, which is
#      exactly right for a cold standup.
#
#   3. Tigris credentials are shown ONCE. `fly storage create` prints
#      AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY to stdout and sets them as
#      secrets on the single app named in --app. There is no way to read them
#      back later: no `fly storage` subcommand reveals them, `fly storage
#      update` has no credential flags, and the addon's GraphQL `environment`
#      field returns {}. Both apps need them, so this script captures that one
#      stdout and fans the values out to both. Do not split bucket creation out
#      of this script and expect to wire the second app up afterwards.
#
# Usage:
#   GEMINI_API_KEY=... scripts/fly/bootstrap.sh
#   GEMINI_API_KEY=... scripts/fly/bootstrap.sh --bucket kb-demo-snapshots-iad
#   scripts/fly/bootstrap.sh --no-seed     # provision only; bases fill on the first daily tick
#                                          # (serving stays down until then — see trap 1)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SERVE_APP="${SERVE_APP:-kb-demo}"
BUILDER_APP="${BUILDER_APP:-kb-demo-builder}"
# Tigris bucket names are globally unique, and Fly allows one Tigris *project*
# per app — a second `fly storage create --app X` fails with "a Tigris project
# named … already exists for app X" even under a new bucket name. Default
# carries the region so a redo after a partial teardown does not collide.
BUCKET="${BUCKET:-kb-demo-snapshots-$(node scripts/fly/builder-args.mjs --region)}"
SEED=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-seed) SEED=0 ;;
    --bucket) shift; BUCKET="${1:?--bucket needs a value}" ;;
    --bucket=*) BUCKET="${1#--bucket=}" ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v fly >/dev/null 2>&1 || { echo "error: flyctl not on PATH (try: export PATH=\"\$HOME/.fly/bin:\$PATH\")." >&2; exit 1; }
: "${GEMINI_API_KEY:?set GEMINI_API_KEY — both apps need it; fly.toml/fly.builder.toml pin KB_EMBEDDER=gemini, and without a key the server silently falls back to ollama/mistral and fails later at synthesis instead of at startup}"

# Region + [[vm]] + [env] all come from fly.builder.toml via this one shim,
# which also hard-fails if the two tomls' primary_region ever disagree.
mapfile -t BUILDER_ARGS < <(node scripts/fly/builder-args.mjs)
REGION="$(node scripts/fly/builder-args.mjs --region)"
echo "==> region $REGION · bucket $BUCKET · serving $SERVE_APP · builder $BUILDER_APP"

app_exists() { fly apps list --json 2>/dev/null | grep -q "\"$1\""; }

# ---- 1. Apps ---------------------------------------------------------------
echo "==> 1/8 creating apps (idempotent)"
for app in "$SERVE_APP" "$BUILDER_APP"; do
  if app_exists "$app"; then
    echo "    $app already exists"
  else
    fly apps create "$app"
  fi
done

# ---- 2. Tigris bucket, created ONCE, credentials fanned out to both apps ----
echo "==> 2/8 provisioning Tigris bucket + fanning credentials to both apps"
# Created against the BUILDER (the only writer); serving gets the same keys
# copied in below and only ever reads. If this step says the project already
# exists, the keys are gone (see trap 3) — pick a new --bucket name or run
# teardown.sh first.
storage_out="$(fly storage create -n "$BUCKET" --app "$BUILDER_APP" --yes 2>&1)" || {
  echo "$storage_out" >&2
  echo "error: bucket creation failed. If it says a Tigris project already exists for" >&2
  echo "       $BUILDER_APP, its credentials are unrecoverable — re-run with a new" >&2
  echo "       --bucket <name>, or scripts/fly/teardown.sh first." >&2
  exit 1
}
# Echo back which values arrived, never the values themselves.
echo "$storage_out" | grep -oE '^(AWS_[A-Z_]+|BUCKET_NAME)' | sed 's/^/    got /' || true

# Parse the one-and-only printing of the credentials.
creds=()
while IFS= read -r line; do
  case "$line" in
    AWS_ACCESS_KEY_ID:*|AWS_SECRET_ACCESS_KEY:*|AWS_ENDPOINT_URL_S3:*|AWS_REGION:*|BUCKET_NAME:*)
      key="${line%%:*}"
      val="${line#*: }"
      creds+=("$key=$val")
      ;;
  esac
done <<< "$storage_out"

if (( ${#creds[@]} < 5 )); then
  echo "error: could not parse Tigris credentials out of \`fly storage create\` output." >&2
  echo "       Got ${#creds[@]}/5 values. They are printed only once, so this run cannot" >&2
  echo "       be resumed — destroy the bucket and re-run:" >&2
  echo "         fly storage destroy $BUCKET --yes && scripts/fly/bootstrap.sh" >&2
  exit 1
fi

# --stage: no machines exist yet on a fresh app, so an unstaged set would error.
# Staged secrets apply to the first machine created, which is what we want.
fly secrets set -a "$SERVE_APP" --stage "${creds[@]}" >/dev/null
echo "    copied ${#creds[@]} bucket values to $SERVE_APP"

# ---- 3. Provider key on both apps -----------------------------------------
echo "==> 3/8 setting GEMINI_API_KEY on both apps"
fly secrets set -a "$SERVE_APP" --stage GEMINI_API_KEY="$GEMINI_API_KEY" >/dev/null
fly secrets set -a "$BUILDER_APP" --stage GEMINI_API_KEY="$GEMINI_API_KEY" >/dev/null

# ---- 4. Builder image ------------------------------------------------------
echo "==> 4/8 building + pushing the builder image"
# --build-only --push: a plain `fly deploy` on an app with no
# [http_service]/[processes] still creates a machine running the image's default
# CMD (the serving entrypoint), which would clobber the scheduled machine.
fly deploy -a "$BUILDER_APP" -c fly.builder.toml --build-only --push

# ---- 5. Cold seed (no roll — see trap 2) -----------------------------------
if [[ "$SEED" -eq 1 ]]; then
  echo "==> 5/8 cold-seeding every base in scripts/fly/bases.json"
  echo "    (all bases build from scratch on an empty bucket; SERVE_APP/FLY_API_TOKEN"
  echo "     are intentionally still unset, so refresh.sh skips the serving roll)"
  fly machine run . -c fly.builder.toml -a "$BUILDER_APP" --rm \
      "${BUILDER_ARGS[@]}" \
      bash /app/scripts/fly/refresh.sh
else
  echo "==> 5/8 skipped (--no-seed) — NOTE: serving cannot boot until a snapshot"
  echo "    exists (trap 1), so step 6 will fail until the first builder run lands."
fi

# ---- 6. Serving node -------------------------------------------------------
echo "==> 6/8 deploying the serving node"
# --wait-timeout: boot serially imports every seeded base before the port opens.
fly deploy -a "$SERVE_APP" -c fly.toml --wait-timeout 15m

# ---- 7. Roll credentials, now that serving has machines to roll -------------
echo "==> 7/8 giving the builder permission to roll serving"
roll_token="$(fly tokens create deploy -a "$SERVE_APP" --expiry 8760h | tail -n1)"
# --stage: the seed machine was --rm, so the builder app has no machines right
# now and an unstaged `secrets set` has nothing to restart. The scheduler
# created in step 8 picks these up at creation.
fly secrets set -a "$BUILDER_APP" --stage \
    SERVE_APP="$SERVE_APP" \
    FLY_API_TOKEN="$roll_token" >/dev/null
echo "    SERVE_APP + FLY_API_TOKEN set on $BUILDER_APP"

# ---- 8. Daily scheduler ----------------------------------------------------
echo "==> 8/8 creating the daily scheduler machine"
# A scheduled machine pins its image, vm size, and env at creation time — which
# is why deploy.sh destroys and recreates it rather than updating it.
fly machine run . -c fly.builder.toml -a "$BUILDER_APP" --detach \
    "${BUILDER_ARGS[@]}" \
    --schedule daily --restart no \
    bash /app/scripts/fly/refresh.sh

echo
echo "==> verifying"
curl -sS "https://${SERVE_APP}.fly.dev/healthz" || true
echo
curl -sS "https://${SERVE_APP}.fly.dev/v1/bases" 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { console.log("bases:", (JSON.parse(s).bases || []).map(b => b.name).join(", ")) }
    catch { console.log("(could not parse /v1/bases)") }
  });
' || true

cat <<EOS

==> up. One manual step remains, for CI:

  .github/workflows/fly-deploy.yml deploys on every push to main using
  app-scoped deploy tokens stored as GitHub secrets. Those tokens do not
  survive an app being destroyed and recreated, so set them now:

    gh secret set FLY_API_TOKEN_KB_DEMO --body "\$(fly tokens create deploy -a $SERVE_APP --expiry 8760h | tail -n1)"
    gh secret set FLY_API_TOKEN_KB_DEMO_BUILDER --body "\$(fly tokens create deploy -a $BUILDER_APP --expiry 8760h | tail -n1)"

  Until then CI's deploy job fails on push even though the demo is healthy.
EOS
