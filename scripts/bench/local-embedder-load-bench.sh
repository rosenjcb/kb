#!/usr/bin/env bash
# Isolated RSS measurement for LocalEmbedder's one-time model load (issue #196).
#
# `LocalEmbedder.embed()` (packages/kb-core/src/core/embeddings.ts) lazily
# imports `@huggingface/transformers` and loads the ONNX runtime +
# `Xenova/all-MiniLM-L6-v2` weights on first call. Issue #196 asked whether
# that one-time load is large enough to matter on top of whatever memory a
# cold `kb init`/`kb-server refresh` has already accumulated by the time it
# reaches the trailing `embedAllFacts()` step. The `onnxruntime-node` native
# binding is platform-specific (no darwin/x64 prebuilt, for example), so this
# can't be measured by just running a script against the repo's own
# node_modules on an arbitrary dev host — it needs a real install inside a
# Linux container, same reasoning as large-repo-memory-bench.sh.
#
# This is a manual/on-demand check (Docker build + npm install), NOT wired
# into `pnpm test`/CI. Run it after touching `LocalEmbedder` or updating the
# `@huggingface/transformers` version, and after touching anything in
# packages/kb-core/src/core/INIT.md's "Memory scaling on large cold indexes"
# section.
#
# Usage:
#   scripts/bench/local-embedder-load-bench.sh
#
# Env vars (all optional):
#   TRANSFORMERS_VERSION   pinned to packages/kb-core/package.json's
#                          `@huggingface/transformers` dependency by default
#   NODE_IMAGE             docker image to run in (default: node:24-slim)
#   WORK_DIR               scratch dir for the throwaway npm project (default:
#                          $HOME/.kb-embedder-bench — must be under a path
#                          Docker Desktop shares with the VM on macOS; /tmp
#                          paths from ephemeral sandboxes are often NOT shared)
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"

TRANSFORMERS_VERSION="${TRANSFORMERS_VERSION:-$(
  node -e "process.stdout.write(require('$REPO_ROOT/packages/kb-core/package.json').optionalDependencies['@huggingface/transformers'].replace(/^\^/, ''))"
)}"
NODE_IMAGE="${NODE_IMAGE:-node:24-slim}"
WORK_DIR="${WORK_DIR:-$HOME/.kb-embedder-bench}"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
cp "$SELF_DIR/local-embedder-load-bench.mjs" "$WORK_DIR/bench.mjs"
cat > "$WORK_DIR/package.json" <<JSON
{ "name": "kb-embedder-bench", "private": true, "type": "module" }
JSON

echo "▶ measuring LocalEmbedder model-load RSS in $NODE_IMAGE (transformers@$TRANSFORMERS_VERSION)"
docker run --rm -v "$WORK_DIR:/work" -w /work "$NODE_IMAGE" bash -c "
  npm install @huggingface/transformers@$TRANSFORMERS_VERSION --no-save --silent
  node --expose-gc bench.mjs
"

rm -rf "$WORK_DIR"
