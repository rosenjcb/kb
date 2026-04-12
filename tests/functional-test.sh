#!/usr/bin/env bash
set -euo pipefail

echo "Functional CLI test: build artifact, run CLI workflow"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_FILE="/tmp/kb-functional-$(date +%s).md"

cleanup() {
  rm -f "$SESSION_FILE" 2>/dev/null || true
}

trap cleanup EXIT

cd "$ROOT_DIR"

npm run build:cli >/dev/null

KB_RUN=(node dist/bin/kb.js)

echo "Step 1/3: create document"
"${KB_RUN[@]}" "$SESSION_FILE" "Create a document titled 'Functional Shell Test' with content 'Created from shell-driven CLI functional test.' and tag it with 'functional' and 'cli'." >/tmp/kb-functional-step1.log 2>&1

echo "Step 2/3: read document"
"${KB_RUN[@]}" "$SESSION_FILE" "Find documents tagged functional and summarize in one sentence." >/tmp/kb-functional-step2.log 2>&1

echo "Step 3/3: assert artifacts"
if [[ ! -f "$ROOT_DIR/sessions/documents/functional-shell-test.md" ]]; then
  echo "FAIL: expected sessions/documents/functional-shell-test.md"
  exit 1
fi

if ! grep -qi "functional" /tmp/kb-functional-step2.log; then
  echo "FAIL: expected read response to mention functional"
  echo "--- step2 output ---"
  cat /tmp/kb-functional-step2.log
  exit 1
fi

echo "PASS: functional shell-driven CLI workflow succeeded"