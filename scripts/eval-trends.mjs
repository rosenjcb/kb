#!/usr/bin/env node
/**
 * Aggregate evaluation artifacts across:
 * - ~/.kb/evaluations/<run>/artifact.json
 * - ./evaluation/runs/*.json
 *
 * Usage:
 *   node scripts/eval-trends.mjs --suite raylib
 *   node scripts/eval-trends.mjs --suite raylib --limit 20
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  const out = {
    suite: '',
    limit: 50,
    help: false,
  }
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

Aggregate evaluation trends across local + ~/.kb artifacts.

Usage:
  node scripts/eval-trends.mjs --suite <name> [--limit N]

Examples:
  node scripts/eval-trends.mjs --suite raylib
  node scripts/eval-trends.mjs --suite kb --limit 12`)
}

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function metric(artifact, key) {
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
  if (key === 'specificity') return q?.mean_specificity ?? c?.mean_specificity ?? null
  if (key === 'evidence') return q?.mean_evidence_handling ?? c?.mean_evidence_handling ?? null
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
      if (!artifact?.aggregate_scores) continue
      rows.push({
        source: 'home',
        id: entry.name,
        file: artifactPath,
        artifact,
      })
    }
  }

  if (fs.existsSync(repoRuns)) {
    for (const entry of fs.readdirSync(repoRuns, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const artifactPath = path.join(repoRuns, entry.name)
      const artifact = safeJson(artifactPath)
      if (!artifact?.aggregate_scores) continue
      rows.push({
        source: 'repo',
        id: entry.name.replace(/\.json$/i, ''),
        file: artifactPath,
        artifact,
      })
    }
  }

  return rows
}

function matchesSuite(row, suite) {
  const p = suite.toLowerCase()
  if (!p) return true
  const a = row.artifact
  const haystack = [row.id, a?.run?.suite, a?.repository?.name, a?.run_label, a?.run?.run_name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(p)
}

function toDateValue(row) {
  const raw = row.artifact?.created_at
  if (!raw) return Number.NaN
  const t = new Date(raw).getTime()
  return Number.isFinite(t) ? t : Number.NaN
}

function mean(xs) {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function sparkline(values, maxWidth = 28) {
  const chars = '▁▂▃▄▅▆▇█'
  if (!values.length) return ''
  const trimmed = values.slice(Math.max(0, values.length - maxWidth))
  const min = Math.min(...trimmed)
  const max = Math.max(...trimmed)
  if (max === min) return '▅'.repeat(trimmed.length)
  return trimmed
    .map(v => {
      const idx = Math.max(0, Math.min(chars.length - 1, Math.round(((v - min) / (max - min)) * 7)))
      return chars[idx]
    })
    .join('')
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(3) : 'n/a'
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help || !args.suite) {
    printHelp()
    process.exit(args.help ? 0 : 1)
  }

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const all = gatherAllArtifacts(repoRoot)
  const filtered = all
    .filter(row => matchesSuite(row, args.suite))
    .map(row => ({
      ...row,
      created: row.artifact?.created_at ?? null,
      status: row.artifact?.status ?? null,
      usefulness: metric(row.artifact, 'usefulness'),
      pass_rate: metric(row.artifact, 'pass_rate'),
      correctness: metric(row.artifact, 'correctness'),
      specificity: metric(row.artifact, 'specificity'),
      evidence: metric(row.artifact, 'evidence'),
    }))
    .filter(row => typeof row.usefulness === 'number' && typeof row.pass_rate === 'number')
    .sort((a, b) => toDateValue(a) - toDateValue(b))

  if (filtered.length === 0) {
    console.log(`[eval-trends] no scored runs for suite "${args.suite}"`)
    process.exit(0)
  }

  const limited = filtered.slice(Math.max(0, filtered.length - args.limit))
  const use = limited.map(r => r.usefulness)
  const pass = limited.map(r => r.pass_rate)
  const corr = limited.map(r => r.correctness)

  const first = limited[0]
  const last = limited[limited.length - 1]
  const firstNonZero = limited.find(r => (r.usefulness ?? 0) > 0 || (r.pass_rate ?? 0) > 0) || first
  const previous = limited.length > 1 ? limited[limited.length - 2] : null
  const delta = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : null)

  console.log(
    `[eval-trends] suite=${args.suite} runs=${limited.length} (total matched=${filtered.length})`
  )
  console.log(
    `[eval-trends] latest=${last.id} usefulness=${fmt(last.usefulness)} pass_rate=${fmt(last.pass_rate)} correctness=${fmt(last.correctness)}`
  )
  console.log(
    `[eval-trends] delta(first->latest) usefulness=${fmt(delta(last.usefulness, first.usefulness))} pass_rate=${fmt(delta(last.pass_rate, first.pass_rate))} correctness=${fmt(delta(last.correctness, first.correctness))}`
  )
  console.log(
    `[eval-trends] delta(first_nonzero->latest) usefulness=${fmt(delta(last.usefulness, firstNonZero.usefulness))} pass_rate=${fmt(delta(last.pass_rate, firstNonZero.pass_rate))} correctness=${fmt(delta(last.correctness, firstNonZero.correctness))}`
  )
  if (previous) {
    console.log(
      `[eval-trends] delta(previous->latest) usefulness=${fmt(delta(last.usefulness, previous.usefulness))} pass_rate=${fmt(delta(last.pass_rate, previous.pass_rate))} correctness=${fmt(delta(last.correctness, previous.correctness))}`
    )
  }
  console.log(
    `[eval-trends] means usefulness=${fmt(mean(use))} pass_rate=${fmt(mean(pass))} correctness=${fmt(mean(corr))}`
  )
  console.log(`[eval-trends] usefulness trend ${sparkline(use)}`)
  console.log(`[eval-trends] pass-rate trend  ${sparkline(pass)}`)
  console.log('')
  console.log('date | run | use | pass | corr | status | source')
  for (const row of limited) {
    const d = row.created ? String(row.created).slice(0, 19) : 'unknown'
    console.log(
      `${d} | ${row.id} | ${fmt(row.usefulness)} | ${fmt(row.pass_rate)} | ${fmt(row.correctness)} | ${row.status || 'n/a'} | ${row.source}`
    )
  }
}

main()
