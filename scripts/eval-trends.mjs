#!/usr/bin/env node
/**
 * Aggregate and compare evaluation artifacts across:
 * - ~/.kb/evaluations/<run>/artifact.json
 * - ./evaluation/runs/*.json
 *
 * Shows structural metrics (docs, entities, avg results) for every run,
 * plus score columns when auto-scoring was used. This is the canonical
 * comparison tool — never write ad-hoc scripts to compare runs.
 *
 * Usage:
 *   node scripts/eval-trends.mjs --suite kb
 *   node scripts/eval-trends.mjs --suite raylib --limit 20
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { suiteDisplayLabel } from './eval-shared.mjs'

function parseArgs(argv) {
  const out = { suite: '', limit: 50, help: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--suite') out.suite = String(argv[++i] || '').trim()
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 50)
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function printHelp() {
  console.log(`eval-trends.mjs

Aggregate and compare evaluation runs for a suite. Shows structural
metrics for all runs; score columns populated only for auto-scored runs.

This is the canonical comparison tool — never write ad-hoc scripts.

Usage:
  node scripts/eval-trends.mjs --suite <name> [--limit N]

Examples:
  node scripts/eval-trends.mjs --suite kb
  node scripts/eval-trends.mjs --suite raylib --limit 12`)
}

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function scoreMetric(artifact, key) {
  const q = artifact?.aggregate_scores?.query
  const c = artifact?.aggregate_scores?.combined
  if (key === 'usefulness') return q?.mean_usefulness ?? c?.mean_usefulness ?? null
  if (key === 'pass_rate')
    return (
      q?.pass_rate_correctness_and_usefulness_at_least_3 ??
      c?.pass_rate_correctness_and_usefulness_at_least_3 ??
      null
    )
  if (key === 'correctness') return q?.mean_correctness ?? c?.mean_correctness ?? null
  return null
}

function structuralMetric(artifact, key) {
  const init = artifact?.run?.init_result
  const gs = init?.graph_summary
  if (key === 'docs') return init?.written_docs ?? null
  if (key === 'entities') return gs?.entities ?? null
  if (key === 'rels') return gs?.relationships ?? null
  if (key === 'avg_results') {
    const qe = artifact?.query_evaluation ?? []
    if (!qe.length) return null
    const counts = qe.map(q => q.result_count ?? 0)
    return counts.reduce((a, b) => a + b, 0) / counts.length
  }
  return null
}

function gatherAllArtifacts(repoRoot) {
  const rows = []
  const homeRoot = path.join(os.homedir(), '.kb', 'evaluations')
  const repoRuns = path.join(repoRoot, 'evaluation', 'runs')

  if (fs.existsSync(homeRoot)) {
    for (const entry of fs.readdirSync(homeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'repos') continue
      const artifactPath = path.join(homeRoot, entry.name, 'artifact.json')
      if (!fs.existsSync(artifactPath)) continue
      const artifact = safeJson(artifactPath)
      if (!artifact?.status) continue
      rows.push({ source: 'home', id: entry.name, file: artifactPath, artifact })
    }
  }

  if (fs.existsSync(repoRuns)) {
    for (const entry of fs.readdirSync(repoRuns, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const artifactPath = path.join(repoRuns, entry.name)
      const artifact = safeJson(artifactPath)
      if (!artifact?.status) continue
      rows.push({ source: 'repo', id: entry.name.replace(/\.json$/i, ''), file: artifactPath, artifact })
    }
  }

  return rows
}

function matchesSuite(row, suite) {
  if (!suite) return true
  const p = suite.toLowerCase()
  const a = row.artifact
  // Prefer exact match on the run.suite field (avoids "kb-docgen" matching "kb")
  const runSuite = (a?.run?.suite ?? '').toLowerCase()
  if (runSuite) return runSuite === p
  // Fallback for older artifacts without run.suite
  const haystack = [row.id, a?.repository?.name, a?.run_label, a?.run?.run_name]
    .filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(p)
}

function toDateValue(row) {
  const raw = row.artifact?.created_at
  if (!raw) return Number.NaN
  const t = new Date(raw).getTime()
  return Number.isFinite(t) ? t : Number.NaN
}


function sparkline(values, maxWidth = 28) {
  const chars = '▁▂▃▄▅▆▇█'
  const nums = values.filter(v => typeof v === 'number')
  if (!nums.length) return ''
  const trimmed = nums.slice(Math.max(0, nums.length - maxWidth))
  const min = Math.min(...trimmed)
  const max = Math.max(...trimmed)
  if (max === min) return '▅'.repeat(trimmed.length)
  return trimmed.map(v => {
    const idx = Math.max(0, Math.min(7, Math.round(((v - min) / (max - min)) * 7)))
    return chars[idx]
  }).join('')
}

function fmtN(n) {
  if (n === null || n === undefined) return '  -'
  if (Number.isInteger(n)) return String(n).padStart(3)
  return n.toFixed(1).padStart(5)
}

function fmtScore(n) {
  return (n === null || n === undefined) ? '  -  ' : n.toFixed(3)
}

function delta(a, b) {
  return (typeof a === 'number' && typeof b === 'number') ? a - b : null
}

function fmtDelta(n) {
  if (n === null) return '  -  '
  const s = (n >= 0 ? '+' : '') + n.toFixed(3)
  return s
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help || !args.suite) { printHelp(); process.exit(args.help ? 0 : 1) }

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const all = gatherAllArtifacts(repoRoot)
  const filtered = all
    .filter(row => matchesSuite(row, args.suite))
    .map(row => ({
      ...row,
      created: row.artifact?.created_at ?? null,
      status: row.artifact?.status ?? null,
      docs: structuralMetric(row.artifact, 'docs'),
      entities: structuralMetric(row.artifact, 'entities'),
      rels: structuralMetric(row.artifact, 'rels'),
      avg_results: structuralMetric(row.artifact, 'avg_results'),
      usefulness: scoreMetric(row.artifact, 'usefulness'),
      pass_rate: scoreMetric(row.artifact, 'pass_rate'),
      correctness: scoreMetric(row.artifact, 'correctness'),
    }))
    // Drop rows that have no structural data at all (e.g. docgen runs)
    .filter(row => row.docs !== null || row.entities !== null || row.avg_results !== null)
    .sort((a, b) => toDateValue(a) - toDateValue(b))
    .slice(-args.limit)

  if (filtered.length === 0) {
    console.log(`[eval-trends] no runs found for suite "${args.suite}"`)
    process.exit(0)
  }

  const last = filtered[filtered.length - 1]
  const prev = filtered.length > 1 ? filtered[filtered.length - 2] : null
  const first = filtered[0]
  // A run is "scored" only when at least one axis is non-zero (all-zero = unscored placeholder)
  const scoredRuns = filtered.filter(r =>
    typeof r.usefulness === 'number' && (r.usefulness > 0 || r.pass_rate > 0 || r.correctness > 0)
  )

  console.log(`[eval-trends] suite=${args.suite} (${suiteDisplayLabel(args.suite)})  runs=${filtered.length}  scored=${scoredRuns.length}`)
  console.log(`[eval-trends] latest  docs=${fmtN(last.docs).trim()} entities=${fmtN(last.entities).trim()} rels=${fmtN(last.rels).trim()} avg_results=${last.avg_results !== null ? last.avg_results.toFixed(1) : '-'}`)
  if (scoredRuns.length) {
    const sl = scoredRuns[scoredRuns.length - 1]
    console.log(`[eval-trends] latest (scored)  use=${fmtScore(sl.usefulness)} pass=${fmtScore(sl.pass_rate)} corr=${fmtScore(sl.correctness)}`)
  }
  if (prev) {
    console.log(`[eval-trends] delta(prev→latest)  docs=${fmtDelta(delta(last.docs, prev.docs))} entities=${fmtDelta(delta(last.entities, prev.entities))} avg_results=${fmtDelta(delta(last.avg_results, prev.avg_results))}`)
  }
  console.log(`[eval-trends] delta(first→latest)  docs=${fmtDelta(delta(last.docs, first.docs))} entities=${fmtDelta(delta(last.entities, first.entities))}`)

  const entitiesSpark = sparkline(filtered.map(r => r.entities))
  const resultsSpark = sparkline(filtered.map(r => r.avg_results))
  const useSpark = sparkline(scoredRuns.map(r => r.usefulness))
  if (entitiesSpark) console.log(`[eval-trends] entities trend    ${entitiesSpark}`)
  if (resultsSpark) console.log(`[eval-trends] avg-results trend ${resultsSpark}`)
  if (useSpark) console.log(`[eval-trends] usefulness trend  ${useSpark}`)

  console.log('')
  const W = 26
  const hdr = `${'date'.padEnd(20)} ${'run'.padEnd(W)} ${'docs'.padStart(4)} ${'ent'.padStart(5)} ${'rels'.padStart(5)} ${'res'.padStart(5)} ${'use'.padStart(6)} ${'pass'.padStart(6)} ${'corr'.padStart(6)}  src`
  console.log(hdr)
  console.log('-'.repeat(hdr.length))
  for (const r of filtered) {
    const d = r.created ? String(r.created).slice(0, 19) : 'unknown             '
    const id = r.id.length > W ? `${r.id.slice(0, W - 1)}…` : r.id.padEnd(W)
    const line = [d, id, fmtN(r.docs), fmtN(r.entities), fmtN(r.rels), fmtN(r.avg_results),
      fmtScore(r.usefulness), fmtScore(r.pass_rate), fmtScore(r.correctness), ` ${r.source}`].join(' ')
    console.log(line)
  }
}

main()
