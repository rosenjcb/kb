#!/usr/bin/env bash
# Shared helpers for the GCP build-to-serve orchestration.
#
# NATIVE Google Cloud Storage — no AWS CLI, no S3, no HMAC keys. Transport is
# `gcloud storage`, authenticated by the Cloud Run service account's Application
# Default Credentials (ADC). Nothing here talks to AWS.
#
# The corruption-safe model is unchanged from the vendor-agnostic design: the
# builder exports a `VACUUM INTO` snapshot (one consistent .kb-index.sqlite,
# sha256-stamped in kb-snapshot.json), uploads it under an *immutable* versioned
# prefix, then flips a tiny latest.json pointer (the single commit point). The
# serving node downloads that prefix and adopts it with `kb-server import` /
# `start --from`, which verifies the sha256 before serving.
#
# Full model: packages/kb-server/HANDOFF.md
set -euo pipefail

# ---- kb-server invocation inside the image ---------------------------------
KB_SERVER_JS="${KB_SERVER_JS:-/app/packages/kb-server/dist/bin/kb-server.js}"
kb_server() { node "$KB_SERVER_JS" "$@"; }

# ---- Configuration ----------------------------------------------------------
KB_BASE="${KB_BASE:-kb}"
# Object-store root. Each base lives at <SNAPSHOT_ROOT>/<base>/…
SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-snapshots}"
SNAPSHOT_PREFIX="${SNAPSHOT_PREFIX:-${SNAPSHOT_ROOT}/${KB_BASE}}"
# Keep this many immutable snapshot versions per base; older ones are pruned.
SNAPSHOT_KEEP="${SNAPSHOT_KEEP:-6}"
# Committed base manifest (default: baked next to this file; the deployment can
# override with BASES_MANIFEST, e.g. a secret-mounted /config/bases.json).
BASES_MANIFEST="${BASES_MANIFEST:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bases.json}"

# Plain GCS bucket NAME — not a URL, not s3://. Objects live at gs://$BUCKET_NAME/…
BUCKET_NAME="${BUCKET_NAME:-}"

# Object-store prefix for one base: <SNAPSHOT_ROOT>/<base>.
snapshot_prefix_for() { printf '%s/%s' "$SNAPSHOT_ROOT" "$1"; }

# Emit one TSV row per base from the manifest: name<TAB>repos<TAB>reserved<TAB>default.
# `repos` is a SPACE-separated list of git targets (`url` or `url#branch`) — feed
# it straight to KB_GIT_REPOS for a multi-repo base. Supports the `repos: [...]`
# array (entries: "url", "url#branch", or {url,branch}) and the legacy single
# `repo`(+`branch`) fields. Column 3 is reserved (branches are folded into col 2).
each_base() {
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const target = (url, branch) => (branch ? String(url) + "#" + branch : String(url));
    for (const b of m.bases || []) {
      let repos = [];
      if (Array.isArray(b.repos)) {
        repos = b.repos
          .map(r => (typeof r === "string" ? r : target(r.url, r.branch)))
          .filter(Boolean);
      } else if (b.repo) {
        repos = [target(b.repo, b.branch)];
      }
      process.stdout.write([b.name, repos.join(" "), "", b.default ? "true" : ""].join("\t") + "\n");
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

require_bucket() {
  if [[ -z "$BUCKET_NAME" ]]; then
    echo "error: BUCKET_NAME is unset. Set it to your GCS bucket NAME (no gs://, no s3://)." >&2
    exit 1
  fi
}

# ---- GCS transport (native `gcloud storage`; ADC auth, no keys) ------------
# Everything funnels through these helpers. Auth is the runtime service account's
# ADC — the container never holds a static key.

# Download an immutable snapshot prefix into a local dir.
#   gcs_pull_prefix <version-prefix> <local-dir>
gcs_pull_prefix() {
  local prefix="$1" dest="$2"
  mkdir -p "$dest"
  # rsync mirrors the prefix CONTENTS into dest (handles the .kb-index.sqlite
  # dotfile and subdirs like checkpoints/ that a shell glob would miss).
  gcloud storage rsync --recursive "gs://${BUCKET_NAME}/${prefix}" "$dest"
}

# Upload a local snapshot dir to an immutable version prefix (never overwritten).
#   gcs_push_prefix <local-dir> <version-prefix>
gcs_push_prefix() {
  local src="$1" prefix="$2"
  gcloud storage rsync --recursive "$src" "gs://${BUCKET_NAME}/${prefix}"
}

# Read a base's pointer JSON to stdout (empty string if none exists yet).
#   gcs_read_pointer [<prefix>]
gcs_read_pointer() {
  local prefix="${1:-$SNAPSHOT_PREFIX}"
  gcloud storage cat "gs://${BUCKET_NAME}/${prefix}/latest.json" 2>/dev/null || true
}

# Atomically publish a base's pointer (single small-object write = commit point).
#   gcs_write_pointer <local-json-file> [<prefix>]
gcs_write_pointer() {
  local prefix="${2:-$SNAPSHOT_PREFIX}"
  gcloud storage cp "$1" "gs://${BUCKET_NAME}/${prefix}/latest.json"
}

# List immutable version dir names under a base prefix, one per line, sorted.
#   gcs_list_versions <prefix>
gcs_list_versions() {
  local prefix="$1"
  # `gcloud storage ls gs://b/prefix/` lists sub-prefixes as .../<version>/ and
  # objects like .../latest.json (no trailing slash). Keep only the dirs.
  gcloud storage ls "gs://${BUCKET_NAME}/${prefix}/" 2>/dev/null \
    | sed -n 's#.*/\([^/][^/]*\)/$#\1#p' | sort
}

# Delete one immutable version dir (best-effort).
#   gcs_rm_version <prefix> <version>
gcs_rm_version() {
  local prefix="$1" v="$2"
  gcloud storage rm --recursive "gs://${BUCKET_NAME}/${prefix}/${v}/" >/dev/null 2>&1 || true
}

# ---- JSON helper (no jq; node is always present) ---------------------------
# json_get 'a.b.c' < <json-on-stdin>  -> value on stdout, empty on miss.
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
