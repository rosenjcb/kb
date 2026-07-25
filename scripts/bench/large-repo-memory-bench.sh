#!/usr/bin/env bash
# Bounded-memory regression benchmark for cold indexing (issue #191).
#
# Runs a real `kb-server refresh` cold build against a shallow clone of a large
# repo (default: Homebrew/brew.git — the actual `brew` base in
# scripts/fly/bases.json that OOM-killed the Fly builder at 8 GiB) inside
# `docker run --memory=2g --memory-swap=2g` (hard cap, no swap headroom).
# Samples cgroup memory every SAMPLE_INTERVAL_SECONDS and checks `docker
# inspect ... State.OOMKilled` on exit — the app's own health check can't be
# trusted here (a dying process just leaves it waiting, which reads as a plain
# timeout instead of an OOM).
#
# Pass criteria (both required, matching the issue's validation section):
#   1. The container is NOT OOM-killed.
#   2. Peak memory PLATEAUS across samples rather than climbing linearly with
#      files processed — passing criterion 1 alone could just mean the repo
#      happened to fit; a flat trend is the actual evidence bounded-memory
#      batching is working.
#
# This is a manual/on-demand check (network clone + Docker build + several
# minutes to run) — it is NOT wired into `pnpm test`/CI. Run it after touching
# anything listed in packages/kb-core/src/core/INIT.md's "Memory scaling on
# large cold indexes" section.
#
# Usage:
#   scripts/bench/large-repo-memory-bench.sh
#   REPO_URL=https://github.com/some/big-repo.git MEMORY_LIMIT=2g scripts/bench/large-repo-memory-bench.sh
#
# Env vars (all optional):
#   REPO_URL               git repo to clone (default: Homebrew/brew.git)
#   MEMORY_LIMIT           docker --memory / --memory-swap value (default: 2g)
#   SAMPLE_INTERVAL_SECONDS  memory-sample cadence (default: 10)
#   WORK_DIR               scratch dir for clone + container volumes
#                          (default: $HOME/.kb-membench — must be under a path
#                          Docker Desktop shares with the VM on macOS; /tmp
#                          paths from ephemeral sandboxes are often NOT shared)
#   SKIP_BUILD             set "true" to reuse an existing kb-membench:latest
#                          image instead of rebuilding from Dockerfile.fly
#   REFRESH_TIMEOUT_MS     `kb-server refresh --timeout` (default: 3600000 = 60min).
#                          The 30min CLI default is too short for `brew`: its
#                          document-facts phase symbol-anchors each doc segment
#                          against every already-indexed AST fact (~9.5k for
#                          brew), which is slow at this repo's symbol count —
#                          a pre-existing cost unrelated to the memory fix this
#                          benchmark validates, but it means the run needs a
#                          longer budget to actually reach the embedding phase.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"

REPO_URL="${REPO_URL:-https://github.com/Homebrew/brew.git}"
MEMORY_LIMIT="${MEMORY_LIMIT:-2g}"
SAMPLE_INTERVAL_SECONDS="${SAMPLE_INTERVAL_SECONDS:-10}"
REFRESH_TIMEOUT_MS="${REFRESH_TIMEOUT_MS:-3600000}"
WORK_DIR="${WORK_DIR:-$HOME/.kb-membench}"
IMAGE_TAG="kb-membench:latest"
CONTAINER=membench-run
BASE_NAME=membench

REPO_SRC="$WORK_DIR/repo-src"
OUT_DIR="$WORK_DIR/out"
SAMPLES="$WORK_DIR/rss-samples.log"

mkdir -p "$WORK_DIR" "$OUT_DIR"

if [[ ! -d "$REPO_SRC/.git" ]]; then
  echo "▶ shallow-cloning $REPO_URL → $REPO_SRC"
  rm -rf "$REPO_SRC"
  git clone --depth 1 "$REPO_URL" "$REPO_SRC"
else
  echo "▶ reusing existing clone at $REPO_SRC"
fi
file_count="$(find "$REPO_SRC" -type f -not -path '*/.git/*' | wc -l | tr -d ' ')"
echo "  · $file_count files, $(du -sh "$REPO_SRC" | cut -f1)"

if [[ "${SKIP_BUILD:-false}" != "true" ]]; then
  echo "▶ building $IMAGE_TAG from Dockerfile.fly (this compiles the real builder image)"
  docker build -f "$REPO_ROOT/Dockerfile.fly" -t "$IMAGE_TAG" "$REPO_ROOT"
else
  echo "▶ SKIP_BUILD=true — reusing existing $IMAGE_TAG"
fi

rm -f "$SAMPLES"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "▶ running cold refresh under --memory=$MEMORY_LIMIT --memory-swap=$MEMORY_LIMIT"
docker run -d \
  --name "$CONTAINER" \
  --memory="$MEMORY_LIMIT" --memory-swap="$MEMORY_LIMIT" \
  -v "$REPO_SRC:/bench/repo:ro" \
  -v "$OUT_DIR:/bench/out" \
  -e KB_HOME=/data \
  -e KB_EMBEDDER=local \
  "$IMAGE_TAG" \
  bash -lc "packages/kb-server/dist/bin/kb-server refresh --base $BASE_NAME --out /bench/out --repos 'file:///bench/repo' --timeout $REFRESH_TIMEOUT_MS --json" \
  >/dev/null

echo "  · container: $CONTAINER"
echo "  · NOTE: the refresh command's bootstrap child runs with stdio:'ignore'"
echo "    (packages/kb-server/src/refresh-cli.ts) by design, so \`docker logs\`"
echo "    never shows per-file progress — this loop reads the init checkpoint"
echo "    + live fact count from the container's own SQLite index instead."

# Small inline script, run via `docker exec ... node`: reports which init
# cycle just completed (read-inputs/code-index/document-facts/import-docs/
# write) and how many facts exist so far, so a benchmark run shows real
# progress instead of just a memory number climbing in the dark.
read -r -d '' PROGRESS_JS <<'EOF' || true
const fs = require('fs')
const path = `/data/sessions/${process.argv[1]}/checkpoints/init-latest.checkpoint.json`
let cycles = '(no checkpoint yet)'
try { cycles = JSON.parse(fs.readFileSync(path, 'utf8')).completedCycles?.join(',') || '(none)' } catch {}
let facts = '?'
try {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(`/data/sessions/${process.argv[1]}/.kb-index.sqlite`, { readOnly: true })
  facts = db.prepare('SELECT COUNT(*) AS c FROM facts').get().c
} catch {}
console.log(`cycles=[${cycles}] facts=${facts}`)
EOF

while docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mem_bytes="$(docker exec "$CONTAINER" cat /sys/fs/cgroup/memory.current 2>/dev/null || echo "")"
  mem_human="$(docker stats "$CONTAINER" --no-stream --format '{{.MemUsage}}' 2>/dev/null || echo "")"
  progress="$(docker exec "$CONTAINER" node -e "$PROGRESS_JS" "$BASE_NAME" 2>/dev/null || echo "cycles=[?] facts=?")"
  echo "$ts mem_bytes=$mem_bytes ($mem_human) $progress" | tee -a "$SAMPLES"
  sleep "$SAMPLE_INTERVAL_SECONDS"
done

exit_code="$(docker wait "$CONTAINER" 2>/dev/null || echo "unknown")"
oom_killed="$(docker inspect -f '{{.State.OOMKilled}}' "$CONTAINER")"
docker logs "$CONTAINER" > "$WORK_DIR/container.log" 2>&1
docker rm "$CONTAINER" >/dev/null

echo ""
echo "── result ──────────────────────────────────────────────"
echo "exit code:  $exit_code"
echo "OOMKilled:  $oom_killed"
echo "samples:    $SAMPLES"
echo "full log:   $WORK_DIR/container.log"
echo ""

sample_count="$(wc -l < "$SAMPLES" | tr -d ' ')"
if [[ "$oom_killed" == "true" ]]; then
  echo "❌ FAIL: container was OOM-killed under $MEMORY_LIMIT."
  exit 1
fi
if (( sample_count < 3 )); then
  echo "⚠ inconclusive: only $sample_count memory sample(s) captured (run finished too fast to judge plateau)."
  exit 0
fi

# Crude plateau heuristic: compare the mean of the last third of samples
# against the mean of the middle third. A real linear-with-files-processed
# leak keeps climbing; bounded-batch processing flattens out early. This is a
# sanity check, not a substitute for eyeballing $SAMPLES. (Pure bash + a
# one-shot awk for the float division — macOS ships BWK awk, not gawk, so no
# gawk-only regex-capture extensions here.)
mapfile -t vals < <(grep -oE 'mem_bytes=[0-9]+' "$SAMPLES" | grep -oE '[0-9]+$')
n=${#vals[@]}
if (( n < 3 )); then
  echo "⚠ inconclusive: only $n numeric sample(s)"
  exit 0
fi
third=$(( n / 3 )); (( third < 1 )) && third=1
mid_start=$third; mid_end=$(( 2 * third )); last_start=$(( n - third ))
mid_sum=0; mid_n=0
for ((i = mid_start; i < mid_end; i++)); do mid_sum=$(( mid_sum + vals[i] )); mid_n=$(( mid_n + 1 )); done
last_sum=0; last_n=0
for ((i = last_start; i < n; i++)); do last_sum=$(( last_sum + vals[i] )); last_n=$(( last_n + 1 )); done
mid_avg=$(( mid_sum / mid_n ))
last_avg=$(( last_sum / last_n ))
growth_pct="$(awk -v m="$mid_avg" -v l="$last_avg" 'BEGIN{printf "%.1f", (l-m)/m*100}')"
printf 'mid-run avg:  %.1f MiB\n' "$(awk -v v="$mid_avg" 'BEGIN{printf "%.1f", v/1048576}')"
printf 'final avg:    %.1f MiB\n' "$(awk -v v="$last_avg" 'BEGIN{printf "%.1f", v/1048576}')"
echo "growth:       ${growth_pct}%"
if awk -v g="$growth_pct" 'BEGIN{exit !(g > 25)}'; then
  echo "❌ FAIL: memory grew >25% from mid-run to end — looks like it is still scaling with files processed, not plateauing."
  exit 1
fi
echo "✅ PASS: not OOM-killed, and memory plateaued (did not keep climbing with files processed)."
