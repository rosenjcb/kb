#!/bin/bash

# KB Agent Harness - CLI Integration Test & Demo
# Tests the CLI as a real user would use it

set -e

echo "🧪 KB AGENT CLI INTEGRATION TEST"
echo "================================\n"

# Setup
RUN_ID="$(date +%s)"
TEST_SESSION="/tmp/kb-cli-test-${RUN_ID}.md"
TEST_DIR="/Users/rosenjcb/kb/sessions/documents"
TS_TITLE="TypeScript Guide ${RUN_ID}"
PY_TITLE="Python Basics ${RUN_ID}"
GO_TITLE="Go Language ${RUN_ID}"
TS_ID="typescript-guide-${RUN_ID}"
PY_ID="python-basics-${RUN_ID}"
GO_ID="go-language-${RUN_ID}"
PASSED=0
FAILED=0

cd /Users/rosenjcb/kb
npm run build:cli >/dev/null

cleanup() {
  echo "\n🧹 Cleaning up test session: $TEST_SESSION"
  rm -f "$TEST_SESSION" 2>/dev/null || true
}

trap cleanup EXIT

run_test() {
  local test_name="$1"
  local query="$2"
  local expect_text="$3"
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "TEST: $test_name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # Run the built CLI artifact
  output=$(node dist/bin/kb.js "$TEST_SESSION" "$query" 2>&1)
  
  # Check for expected text in output
  if echo "$output" | grep -q "$expect_text"; then
    echo "✅ PASSED: Found '$expect_text'"
    ((PASSED++))
  else
    echo "❌ FAILED: Expected to find '$expect_text' in output"
    echo "\nActual output:"
    echo "$output"
    ((FAILED++))
  fi
  
  echo ""
}

# ─────────────────────────────────────────────────────────────
# Test 1: Create first document
# ─────────────────────────────────────────────────────────────
run_test "Create TypeScript Document" \
  "Create a document titled '${TS_TITLE}' with documentId '${TS_ID}' and content about TypeScript being a typed superset of JavaScript. Tag it with 'programming' and 'typescript'." \
  "successfully created"

# ─────────────────────────────────────────────────────────────
# Test 2: Create second document
# ─────────────────────────────────────────────────────────────
run_test "Create Python Document" \
  "Create a document titled '${PY_TITLE}' with documentId '${PY_ID}' and content about Python being a dynamic typed language. Tag it with 'programming' and 'python'." \
  "successfully created"

# ─────────────────────────────────────────────────────────────
# Test 3: Search by title
# ─────────────────────────────────────────────────────────────
run_test "Search by Title" \
  "Search the KB for documents titled '${TS_TITLE}' and tell me what you find." \
  "${TS_TITLE}"

# ─────────────────────────────────────────────────────────────
# Test 4: Search by tag
# ─────────────────────────────────────────────────────────────
run_test "Search by Tag" \
  "Find all documents tagged with 'programming'." \
  "programming"

# ─────────────────────────────────────────────────────────────
# Test 5: Update document
# ─────────────────────────────────────────────────────────────
run_test "Update Document" \
  "Update the document with id '${TS_ID}' to add that it uses static typing." \
  "successfully"

# ─────────────────────────────────────────────────────────────
# Test 6: Multi-step workflow
# ─────────────────────────────────────────────────────────────
run_test "Complex Multi-Step Workflow" \
  "Create a document titled '${GO_TITLE}' with documentId '${GO_ID}' about Go being compiled. Then search for all documents tagged programming. Finally, tell me how many you found." \
  "documents"

# ─────────────────────────────────────────────────────────────
# Verify artifacts
# ─────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "ARTIFACT VERIFICATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check files were created
files_created=$(ls "$TEST_DIR"/*.md 2>/dev/null | wc -l)
echo "📁 Markdown files created: $files_created"

if [ -f "$TEST_DIR/${TS_ID}.md" ]; then
  echo "✅ TypeScript Guide exists"
  ((PASSED++))
else
  echo "❌ TypeScript Guide missing"
  ((FAILED++))
fi

if [ -f "$TEST_DIR/${PY_ID}.md" ]; then
  echo "✅ Python Basics exists"
  ((PASSED++))
else
  echo "❌ Python Basics missing"
  ((FAILED++))
fi

if [ -f "$TEST_DIR/${GO_ID}.md" ]; then
  echo "✅ Go Language exists"
  ((PASSED++))
else
  echo "❌ Go Language missing"
  ((FAILED++))
fi

# Show session file
echo "\n📋 Session file created: $TEST_SESSION"
echo "Session size: $(wc -c < "$TEST_SESSION" | numfmt --to=iec-i --suffix=B 2>/dev/null || wc -c < "$TEST_SESSION") bytes"

echo "\n📝 Sample session content (first 500 chars):"
head -c 500 "$TEST_SESSION" | sed 's/^/   /'

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
echo "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "TEST SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Passed: $PASSED"
echo "❌ Failed: $FAILED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ $FAILED -eq 0 ]; then
  echo "🎉 ALL TESTS PASSED!"
  exit 0
else
  echo "⚠️  SOME TESTS FAILED"
  exit 1
fi
