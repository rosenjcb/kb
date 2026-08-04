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
KB_BASE="${KB_BASE:-kb}"
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

# Required objects for a publishable/adoptable snapshot prefix. Cross-region
# Tigris LIST/GET has been observed to return a *partial* object set (e.g. just
# .kb-index.sqlite + one manifest) while the writer region sees the full prefix
# — which made the serving node crash-loop with "no kb-snapshot.json". Always
# verify these before flipping latest.json and after every download.
SNAPSHOT_MANIFEST_FILE="kb-snapshot.json"
SNAPSHOT_INDEX_FILE=".kb-index.sqlite"
SNAPSHOT_REQUIRED_FILES=("$SNAPSHOT_MANIFEST_FILE" "$SNAPSHOT_INDEX_FILE")

# True when every required snapshot file exists under <dir>.
snapshot_dir_complete() {
  local dir="$1" f
  for f in "${SNAPSHOT_REQUIRED_FILES[@]}"; do
    [[ -f "$dir/$f" ]] || return 1
  done
  return 0
}

# True when every required object exists at s3://$BUCKET_NAME/<prefix>/.
# Uses head-object (not LIST) so a partial LIST cannot false-positive.
s3_prefix_complete() {
  local prefix="$1" f
  for f in "${SNAPSHOT_REQUIRED_FILES[@]}"; do
    _s3api head-object --bucket "$BUCKET_NAME" --key "${prefix}/${f}" >/dev/null 2>&1 || return 1
  done
  return 0
}

# head-object with retries — for post-upload read-after-write confirmation.
s3_wait_prefix_complete() {
  local prefix="$1"
  local attempts="${2:-12}"
  local sleep_s="${3:-5}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if s3_prefix_complete "$prefix"; then
      return 0
    fi
    echo "    ! s3://$BUCKET_NAME/$prefix missing required object(s) (attempt $i/$attempts); retrying in ${sleep_s}s…" >&2
    sleep "$sleep_s"
  done
  return 1
}

# GET one object by EXACT key — never LIST — into <dest>/<relpath>.
#   s3_get_object <version-prefix> <relpath> <dest-dir>
s3_get_object() {
  local prefix="$1" rel="$2" dest="$3"
  mkdir -p "$(dirname "$dest/$rel")"
  _s3 cp --no-progress "s3://${BUCKET_NAME}/${prefix}/${rel}" "$dest/$rel" >&2
}

# Index file names a snapshot carries, one per line, read from its ALREADY
# DOWNLOADED manifest (`contents.index` = the sqlite plus any WAL/SHM). The
# primary index is always included so a manifest that predates the field (or
# fails to parse) still yields a usable key list.
snapshot_manifest_index_files() {
  node -e '
    const fs = require("fs");
    const primary = process.argv[2];
    let files = [];
    try {
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (Array.isArray(m?.contents?.index)) {
        files = m.contents.index.filter(f => typeof f === "string" && f.length > 0);
      }
    } catch {}
    if (!files.includes(primary)) files.unshift(primary);
    // Trailing newline is load-bearing: `read` discards an unterminated last
    // line, which would silently skip the only entry in the common case.
    process.stdout.write(files.map(f => f + "\n").join(""));
  ' "$1" "$SNAPSHOT_INDEX_FILE" 2>/dev/null || printf '%s\n' "$SNAPSHOT_INDEX_FILE"
}

# LIST-free fetch of the required objects into <dest>.
#
# `aws s3 cp --recursive` enumerates with ListObjectsV2, so it can only copy
# what LIST reports. Tigris replicates its LIST index separately from object
# data: when the writer and reader regions differ, a freshly published prefix
# has been observed head-object/GET-ing 200 for every key while LIST returns
# the prefix as EMPTY — so the recursive copy silently downloads nothing and
# the serving node crash-loops on a snapshot that is entirely readable.
#
# The keys we actually need are derivable without LIST: the manifest sits at a
# fixed name, and it names its own index files. Fetch those directly.
#
# Aux objects (source/ast file manifests, checkpoints/) are NOT recovered here
# — they are LIST-discovered and only feed the builder's incremental reindex,
# which regenerates them. A warm build that lands on this path does more work;
# it does not fail, which is what the LIST-only behavior did.
s3_pull_required() {
  local prefix="$1" dest="$2" f
  mkdir -p "$dest"
  s3_get_object "$prefix" "$SNAPSHOT_MANIFEST_FILE" "$dest" || return 1
  # `|| [[ -n "$f" ]]`: belt-and-braces against an unterminated final line.
  while IFS= read -r f || [[ -n "$f" ]]; do
    [[ -z "$f" ]] && continue
    s3_get_object "$prefix" "$f" "$dest" || return 1
  done < <(snapshot_manifest_index_files "$dest/$SNAPSHOT_MANIFEST_FILE")
  snapshot_dir_complete "$dest"
}

# Download an immutable snapshot prefix into a local dir.
# Progress goes to stderr so callers can safely capture stdout (e.g. version=).
# Retries on incomplete pulls — partial cross-region views are not rare — and
# falls back to LIST-free direct GETs of the required objects (see
# s3_pull_required) before writing an attempt off.
#   s3_pull_prefix <version-prefix> <local-dir>
s3_pull_prefix() {
  local prefix="$1" dest="$2"
  local attempts="${S3_PULL_ATTEMPTS:-6}"
  local sleep_s="${S3_PULL_RETRY_SLEEP:-5}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    rm -rf "$dest"
    mkdir -p "$dest"
    # --no-progress keeps version="$(pull…)" from swallowing aws progress text.
    if ! _s3 cp --recursive --no-progress "s3://${BUCKET_NAME}/${prefix}/" "$dest/" >&2; then
      echo "    ! s3 cp failed for s3://$BUCKET_NAME/$prefix (attempt $i/$attempts)" >&2
    fi
    if snapshot_dir_complete "$dest"; then
      return 0
    fi
    echo "    ! downloaded s3://$BUCKET_NAME/$prefix incomplete (missing kb-snapshot.json and/or .kb-index.sqlite) attempt $i/$attempts — refetching required objects by exact key" >&2
    if s3_pull_required "$prefix" "$dest"; then
      echo "    · recovered s3://$BUCKET_NAME/$prefix by direct GET (LIST view was short)" >&2
      return 0
    fi
    sleep "$sleep_s"
  done
  return 1
}

# Upload a local snapshot dir to an immutable version prefix (never overwritten),
# then wait until required objects are readable before returning. Callers must
# still flip latest.json only after this returns success.
#   s3_push_prefix <local-dir> <version-prefix>
s3_push_prefix() {
  local src="$1" prefix="$2"
  _s3 cp --recursive --no-progress "$src/" "s3://${BUCKET_NAME}/${prefix}/" >&2
  if ! s3_wait_prefix_complete "$prefix"; then
    echo "error: uploaded s3://$BUCKET_NAME/$prefix but required objects never became readable." >&2
    echo "       not safe to flip latest.json (cross-region / eventual-consistency gap?)." >&2
    return 1
  fi
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
