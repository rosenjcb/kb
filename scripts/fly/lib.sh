#!/usr/bin/env bash
# Shared helpers for the Fly.io build-to-serve orchestration.
#
# The whole orchestration is corruption-safe by construction because it never
# moves a live volume: the builder produces a `VACUUM INTO` snapshot (one
# consistent .kb-index.sqlite, sha256-stamped in kb-snapshot.json), stages it to
# object storage under an *immutable* versioned prefix, and only then flips a
# tiny `latest.json` pointer. The serving node downloads that immutable prefix
# and adopts it with `kb-server import`/`start --from`, which verifies the
# sha256 before serving. A torn upload or a bad byte fails the verify — it never
# reaches users.
#
# Transport is Tigris (Fly's S3-compatible object store). `fly storage create`
# injects the standard AWS_* creds + BUCKET_NAME as app secrets, so we drive it
# with the AWS CLI. To use a different S3 endpoint, set the same env vars.
#
# Full model: packages/kb-server/HANDOFF.md
set -euo pipefail

# ---- kb-server invocation inside the image ---------------------------------
# The Fly image bundles the compiled server at this path (see Dockerfile.fly).
KB_SERVER_JS="${KB_SERVER_JS:-/app/packages/kb-server/dist/bin/kb-server.js}"
kb_server() { node "$KB_SERVER_JS" "$@"; }

# ---- Configuration (env, with sensible demo defaults) ----------------------
KB_BASE="${KB_BASE:-demo}"
# Shared object-store root. Each base gets its own prefix underneath:
#   <SNAPSHOT_ROOT>/<base>/<version>/…  + <SNAPSHOT_ROOT>/<base>/latest.json
# (SNAPSHOT_PREFIX stays as the default base's prefix for back-compat/overrides.)
SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-snapshots}"
SNAPSHOT_PREFIX="${SNAPSHOT_PREFIX:-${SNAPSHOT_ROOT}/${KB_BASE}}"
# Keep this many immutable snapshot versions per base; older ones are pruned.
SNAPSHOT_KEEP="${SNAPSHOT_KEEP:-6}"

# Committed base manifest (scripts/fly/bases.json) — the single source of truth
# for which bases the orchestration builds and serves. Generated from the eval
# suites by scripts/fly/gen-bases.mjs; shipped in the image next to this file.
BASES_MANIFEST="${BASES_MANIFEST:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bases.json}"

# Object-store prefix for one base: <SNAPSHOT_ROOT>/<base>.
snapshot_prefix_for() { printf '%s/%s' "$SNAPSHOT_ROOT" "$1"; }

# Emit one TSV row per base from the manifest: `name<TAB>repo<TAB>branch<TAB>default`.
# `branch` is empty when the suite pins no branch (remote HEAD is used); `default`
# is `true` for exactly one base (the golden default served without X-KB-Base).
each_base() {
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const b of m.bases || []) {
      process.stdout.write([b.name, b.repo || "", b.branch || "", b.default ? "true" : ""].join("\t") + "\n");
    }
  ' "$BASES_MANIFEST"
}

# The default base name recorded in the manifest (fallback: KB_BASE).
default_base_name() {
  node -e '
    const fs = require("fs");
    try {
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(m.default || (m.bases||[]).find(b=>b.default)?.name || ""));
    } catch { process.stdout.write(""); }
  ' "$BASES_MANIFEST" || true
}

# Bucket + endpoint come from `fly storage create` (Tigris) or your own S3.
BUCKET_NAME="${BUCKET_NAME:-${AWS_BUCKET_NAME:-}}"
AWS_ENDPOINT_URL_S3="${AWS_ENDPOINT_URL_S3:-${AWS_ENDPOINT_URL:-}}"

# ---- S3 helpers (thin wrapper so the transport tool is swappable) ----------
# Everything funnels through these two functions; switch to rclone/gsutil here
# and the rest of the orchestration is unchanged.
_s3() {
  local args=(s3)
  [[ -n "$AWS_ENDPOINT_URL_S3" ]] && args+=(--endpoint-url "$AWS_ENDPOINT_URL_S3")
  aws "${args[@]}" "$@"
}
_s3api() {
  local args=(s3api)
  [[ -n "$AWS_ENDPOINT_URL_S3" ]] && args+=(--endpoint-url "$AWS_ENDPOINT_URL_S3")
  aws "${args[@]}" "$@"
}

require_bucket() {
  if [[ -z "$BUCKET_NAME" ]]; then
    echo "error: BUCKET_NAME is unset. Run 'fly storage create' (Tigris) or set BUCKET_NAME + AWS_* creds." >&2
    exit 1
  fi
}

# Download an immutable snapshot prefix into a local dir.
#   s3_pull_prefix <version-prefix> <local-dir>
s3_pull_prefix() {
  local prefix="$1" dest="$2"
  mkdir -p "$dest"
  _s3 cp --recursive "s3://${BUCKET_NAME}/${prefix}/" "$dest/"
}

# Upload a local snapshot dir to an immutable version prefix (never overwritten).
#   s3_push_prefix <local-dir> <version-prefix>
s3_push_prefix() {
  local src="$1" prefix="$2"
  _s3 cp --recursive "$src/" "s3://${BUCKET_NAME}/${prefix}/"
}

# Read a base's pointer JSON to stdout (empty string if none exists yet).
#   s3_read_pointer [<prefix>]   (defaults to the default base's SNAPSHOT_PREFIX)
s3_read_pointer() {
  local prefix="${1:-$SNAPSHOT_PREFIX}"
  _s3 cp "s3://${BUCKET_NAME}/${prefix}/latest.json" - 2>/dev/null || true
}

# Atomically publish a base's pointer (single small-object PUT is the commit point).
#   s3_write_pointer <local-json-file> [<prefix>]
s3_write_pointer() {
  local prefix="${2:-$SNAPSHOT_PREFIX}"
  _s3 cp "$1" "s3://${BUCKET_NAME}/${prefix}/latest.json" \
    --content-type application/json
}

# ---- JSON helper (no jq dependency; node is always present) ----------------
# json_get '<json>' 'a.b.c' -> value on stdout, empty on miss.
json_get() {
  node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const o = JSON.parse(s);
        const v = process.argv[1].split(".").reduce((a, k) => (a == null ? a : a[k]), o);
        process.stdout.write(v == null ? "" : String(v));
      } catch { process.stdout.write(""); }
    });
  ' "$1"
}
