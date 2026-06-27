#!/usr/bin/env node
/**
 * Regenerate research/tables/results.tex from the latest scored harvest artifacts.
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
