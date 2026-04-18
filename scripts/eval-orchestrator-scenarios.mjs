#!/usr/bin/env node
/**
 * Ticket 106: run subagent tuning matrix (s1–s3) →
 * `evaluation/runs/YYYY-MM-DD-orchestrator-scenario-matrix.json`.
 *
 * Usage (repo root): npm run eval:orchestrator-scenarios
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

execSync(
  'npx vitest run tests/tools/subagent-eval-scenario.test.ts tests/tools/subagent-scenario-matrix.test.ts',
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, WRITE_ORCHESTRATOR_MATRIX: '1' },
  }
)
