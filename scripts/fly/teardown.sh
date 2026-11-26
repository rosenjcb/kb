#!/usr/bin/env bash
# Tear the whole Fly chat demo down to nothing: scheduler machine, both apps,
# and the Tigris bucket holding the published snapshots.
#
# This is the inverse of scripts/fly/bootstrap.sh, and the two are meant to be
# used as a pair — the demo costs a dollar or two a month, so parking it
# between pushes is reasonable, but only if standing it back up is one command.
#
# WHY THE BUCKET GOES TOO (--keep-bucket is almost always wrong)
# --------------------------------------------------------------
# `fly storage create` prints the bucket's AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY exactly once, at creation, and stores them only as
# secrets on the app it was created for. After that they are UNRECOVERABLE:
# there is no `fly storage` subcommand that reveals them, `fly storage update`
# has no credential flags, and the addon's GraphQL `environment` field comes
# back `{}`. Destroying the apps therefore destroys the only copy of the keys —
# a surviving bucket full of snapshots that nothing can authenticate against is
# not a backup, it is a bill. So the default is to destroy it and let the next
# bootstrap cold-build fresh snapshots (~20 min for all 10 bases).
#
# Pass --keep-bucket ONLY if you have already copied the AWS_* values somewhere
# durable and intend to feed them back in via bootstrap.sh's --bucket-creds.
#
# Usage:
#   scripts/fly/teardown.sh                 # destroy scheduler + both apps + bucket
#   scripts/fly/teardown.sh --keep-bucket   # leave the bucket (see warning above)
#   scripts/fly/teardown.sh --yes           # skip the confirmation prompt
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SERVE_APP="${SERVE_APP:-kb-demo}"
BUILDER_APP="${BUILDER_APP:-kb-demo-builder}"
KEEP_BUCKET=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --keep-bucket) KEEP_BUCKET=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

command -v fly >/dev/null 2>&1 || { echo "error: flyctl not on PATH (try: export PATH=\"\$HOME/.fly/bin:\$PATH\")." >&2; exit 1; }

# Which Tigris buckets belong to these apps. `fly storage list` is org-wide, so
# match on the apps' own addons instead of guessing from the name.
buckets_for_app() {
  fly storage list --json 2>/dev/null \
    | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
          let rows = []; try { rows = JSON.parse(s || "[]") } catch {}
          for (const r of rows) if (r.name) console.log(r.name)
        });
      ' 2>/dev/null || true
}

echo "About to destroy:"
echo "  · app $SERVE_APP          (serving node)"
echo "  · app $BUILDER_APP  (builder + its scheduled machine)"
if [[ "$KEEP_BUCKET" -eq 0 ]]; then
  echo "  · the Tigris bucket(s) below, INCLUDING every published snapshot:"
  buckets_for_app | sed 's/^/      - /'
  echo "    (the next bootstrap cold-builds fresh snapshots — see the header note"
  echo "     on why keeping the bucket without its keys is useless)"
else
  echo "  · (--keep-bucket) the bucket survives, but its AWS_* keys die with the"
  echo "    apps unless you have already saved them — see the header note."
fi
echo

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Type the serving app name ($SERVE_APP) to confirm: " confirm
  [[ "$confirm" == "$SERVE_APP" ]] || { echo "aborted."; exit 1; }
fi

# ---- 1. Scheduler machine first -------------------------------------------
# Destroying the app would take it with it, but doing it explicitly keeps a
# half-finished teardown (e.g. a permissions failure on app destroy) from
# leaving a daily machine alive that still writes to the bucket.
echo "==> 1/3 destroying the builder's machines"
if fly apps list --json 2>/dev/null | grep -q "\"$BUILDER_APP\""; then
  while read -r mid; do
    [[ -z "$mid" ]] && continue
    echo "    destroying machine $mid"
    fly machine destroy "$mid" -a "$BUILDER_APP" --force || true
  done < <(fly machine list -a "$BUILDER_APP" --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let m = []; try { m = JSON.parse(s || "[]") } catch {}
      for (const x of m) if (x.id) console.log(x.id)
    });
  ')
else
  echo "    app $BUILDER_APP not present — nothing to do"
fi

# ---- 2. Buckets (before the apps, while the addons still resolve) ----------
if [[ "$KEEP_BUCKET" -eq 0 ]]; then
  echo "==> 2/3 destroying Tigris bucket(s)"
  while read -r bucket; do
    [[ -z "$bucket" ]] && continue
    echo "    destroying bucket $bucket"
    fly storage destroy "$bucket" --yes || echo "    (failed — destroy it by hand: fly storage destroy $bucket)"
  done < <(buckets_for_app)
else
  echo "==> 2/3 skipped (--keep-bucket)"
fi

# ---- 3. The apps ----------------------------------------------------------
echo "==> 3/3 destroying apps"
for app in "$SERVE_APP" "$BUILDER_APP"; do
  if fly apps list --json 2>/dev/null | grep -q "\"$app\""; then
    fly apps destroy "$app" --yes
  else
    echo "    app $app not present — nothing to do"
  fi
done

# ---- 4. Verify nothing is left that can bill -------------------------------
# The whole point of a teardown is a zero bill, so assert it rather than assume
# it. Anything still here is something you would keep paying for: a surviving
# app can hold started machines, a volume outlives the machine that used it,
# and a dedicated IPv4 is billed whether or not anything answers on it.
echo "==> verifying nothing is left billing"
leftovers=0
apps_json="$(fly apps list --json 2>/dev/null || echo '[]')"
for app in "$SERVE_APP" "$BUILDER_APP"; do
  if printf '%s' "$apps_json" | grep -q "\"$app\""; then
    echo "  ✗ app still exists: $app" >&2
    leftovers=$((leftovers + 1))
    # Machines and volumes under a surviving app are the actual charge.
    fly machine list -a "$app" 2>/dev/null | grep -E "started|stopped" | sed 's/^/      machine: /' || true
    fly volumes list -a "$app" 2>/dev/null | grep -E "^ [a-z0-9]" | sed 's/^/      volume: /' || true
  else
    echo "  ✓ app gone: $app"
  fi
done

if [[ "$KEEP_BUCKET" -eq 0 ]]; then
  remaining="$(buckets_for_app | tr -d '[:space:]')"
  if [[ -n "$remaining" ]]; then
    echo "  ✗ Tigris bucket(s) still present:" >&2
    buckets_for_app | sed 's/^/      - /'
    leftovers=$((leftovers + 1))
  else
    echo "  ✓ no Tigris buckets"
  fi
else
  echo "  — bucket kept on purpose (--keep-bucket); it still accrues storage cost"
fi

# A remote `fly deploy` can leave a persistent builder app (fly-builder-*) with
# its own volume — a classic surprise line item that survives destroying your
# own apps, because it is not one of them.
builders="$(printf '%s' "$apps_json" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    let rows = []; try { rows = JSON.parse(s || "[]") } catch {}
    for (const r of rows) if (r.Name && /^fly-builder-/.test(r.Name)) console.log(r.Name)
  });
' 2>/dev/null || true)"
if [[ -n "$builders" ]]; then
  echo "  ! remote builder app(s) present — these bill for their volume:"
  printf '%s\n' "$builders" | sed 's/^/      - /'
  echo "      destroy with: fly apps destroy <name> --yes"
else
  echo "  ✓ no remote builder apps"
fi

if (( leftovers > 0 )); then
  echo
  echo "error: $leftovers resource group(s) survived the teardown — you are still billing." >&2
  echo "       Re-run this script, or remove them by hand with the commands above." >&2
  exit 1
fi

cat <<'EOS'

==> done. Nothing above is billing any more.

Remaining cleanup that is NOT automatic:

  * GitHub Actions secrets FLY_API_TOKEN_KB_DEMO and
    FLY_API_TOKEN_KB_DEMO_BUILDER are app-scoped deploy tokens. They are now
    dead — a token outlives neither its app nor a destroy/recreate of it, so
    .github/workflows/fly-deploy.yml will fail on the next push to main until
    bootstrap.sh mints replacements (it prints the exact `gh secret set` lines).

  * Stand it all back up with:  scripts/fly/bootstrap.sh
    (or run the "Fly demo: stand up" workflow from the Actions tab)
EOS
