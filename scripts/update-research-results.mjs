#!/usr/bin/env node
/**
 * Regenerate research/tables/results.tex from the latest scored harvest artifacts.
 *
 * Merges with the existing file: updates K-side macros from newest scored kb
 * runs; updates N-side only when that run's control status is `complete`.
 * `--skip-control` / partial control never blanks prior N values.
 *
 *   pnpm run research:results
 *
 * Also invoked automatically at the end of `pnpm run eval`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeResearchResultsTex } from './eval-shared.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { outPath } = writeResearchResultsTex(root)
console.log(`→ ${outPath}`)
