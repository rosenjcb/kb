#!/usr/bin/env node
/**
 * Replay graded-retrieval scoring against existing artifact.json files.
 *
 * Uses the suite's current `gold_files` / `gold_scope` / `probes` and each
 * artifact's already-captured `provenance` + `retrieval.detail` — no re-query,
 * no judge, no API key. This is the baseline that makes #216/#217/#218 A/B-able.
 *
 *   node scripts/eval-retrieval-replay.mjs ~/.kb/evaluations/kb-…/artifact.json
 *   node scripts/eval-retrieval-replay.mjs --suite kb --latest
 *   node scripts/eval-retrieval-replay.mjs --suite kb --latest --write
 *   node scripts/eval-retrieval-replay.mjs --all
 *   node scripts/eval-retrieval-replay.mjs --all --suite kb
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attachGradedRetrievalScores,
  computeRetrievalCostMetrics,
  loadVendorSuite,
  matchesSuite,
  writeResearchResultsTex,
} from './eval-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')

function usage() {
  console.error(`Usage:
  node scripts/eval-retrieval-replay.mjs <artifact.json> [--write]
  node scripts/eval-retrieval-replay.mjs --suite <id> --latest [--write]
  node scripts/eval-retrieval-replay.mjs --all [--suite <id>]
`)
}

function parseArgs(argv) {
  const args = {
    artifactPath: null,
    suite: null,
    latest: false,
    all: false,
    write: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--suite') args.suite = argv[++i]
    else if (a === '--latest') args.latest = true
    else if (a === '--all') args.all = true
    else if (a === '--write') args.write = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (!a.startsWith('-')) args.artifactPath = a
    else throw new Error(`unknown flag: ${a}`)
  }
  return args
}

function fmt(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : 'n/a'
}

function listArtifacts(suiteFilter) {
  const homeRoot = path.join(os.homedir(), '.kb', 'evaluations')
  if (!fs.existsSync(homeRoot)) return []
  const rows = []
  for (const entry of fs.readdirSync(homeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'repos' || entry.name.startsWith('_')) continue
    const file = path.join(homeRoot, entry.name, 'artifact.json')
    if (!fs.existsSync(file)) continue
    let artifact
    try {
      artifact = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!artifact?.status) continue
    if (suiteFilter && !matchesSuite({ id: entry.name, artifact }, suiteFilter)) continue
    rows.push({ file, artifact, id: entry.name, created: artifact.created_at ?? '' })
  }
  rows.sort((a, b) => String(b.created).localeCompare(String(a.created)))
  return rows
}

function scoreArtifact(artifact, artifactPath, suiteId, { write = false } = {}) {
  const suite = loadVendorSuite(suiteId)
  const qe = artifact.query_evaluation
  if (!Array.isArray(qe) || qe.length === 0) {
    console.error(`[replay] ${artifactPath}: no query_evaluation — skip`)
    return null
  }

  // Older artifacts predate shapes:/probes:; overlay from the live suite so by_shape is honest.
  for (let i = 0; i < qe.length; i++) {
    if (qe[i].shape == null && suite.shapes?.[i]) qe[i].shape = suite.shapes[i]
  }

  const { graded: summary, probe_coverage: probeCoverage } = attachGradedRetrievalScores(
    qe,
    suite.goldFiles,
    { goldScopeList: suite.goldScope, probesList: suite.probes }
  )
  const tel = artifact.kb_query_telemetry
  const totalTokens = tel
    ? (tel.total_input_tokens ?? 0) + (tel.total_output_tokens ?? 0)
    : null
  const cost = computeRetrievalCostMetrics(qe, {
    totalTokens,
    timeline: artifact.query_timeline,
  })

  console.log(
    `\n[replay] ${path.basename(path.dirname(artifactPath))}  suite=${suiteId}  gold_qs=${summary?.questions_with_gold ?? 0}`
  )
  if (!summary) {
    console.log('  (no gold_files annotated for this suite yet)')
  } else {
    console.log(
      `  R@${summary.k}=${fmt(summary.mean_recall_at_k)}  P@${summary.k}=${fmt(summary.mean_precision_at_k)}  MRR=${fmt(summary.mean_mrr)}  NDCG@${summary.k}=${fmt(summary.mean_ndcg_at_k)}  must_open ${summary.total_must_open_recovered}/${summary.total_must_open}`
    )
    if (summary.recall_at) {
      console.log(
        `  R@1=${fmt(summary.recall_at[1])}  R@3=${fmt(summary.recall_at[3])}  R@5=${fmt(summary.recall_at[5])}  R@10=${fmt(summary.recall_at[10])}`
      )
    }
    for (const [shape, s] of Object.entries(summary.by_shape ?? {})) {
      console.log(
        `  ${shape}: n=${s.n}  R@${summary.k}=${fmt(s.mean_recall_at_k)}  NDCG=${fmt(s.mean_ndcg_at_k)}  must_open ${s.total_must_open_recovered}/${s.total_must_open}`
      )
    }
    if (cost) {
      console.log(
        `  cost: tokens/must_open=${cost.tokens_per_must_open_file ?? 'n/a'}  wasted_budget=${cost.wasted_budget_share ?? 'n/a'}  zero-hit=${cost.questions_with_zero_must_open}`
      )
    }
  }

  if (probeCoverage?.by_probe) {
    console.log('  probes:')
    for (const [probe, s] of Object.entries(probeCoverage.by_probe)) {
      console.log(
        `    ${probe}: targets=${s.target_questions} fired=${s.fired} ran_miss=${s.ran_but_missed} off=${s.off}`
      )
    }
  }

  // Scope mismatches are the free leading indicator from #237 follow-up.
  const scopeMisses = qe.filter(q => q.scope_score && q.scope_score.matched === false)
  if (scopeMisses.length) {
    console.log('  scope misses:')
    for (const q of scopeMisses) {
      console.log(
        `    Q${q.question_id}: expected=${(q.scope_score.expected || []).join('+')}  landed=${(q.scope_score.landed || []).join('+') || '(none)'}`
      )
    }
  }

  if (summary) {
    console.log('  per-question misses:')
    for (const q of qe) {
      if (!q.retrieval_scores) continue
      const rs = q.retrieval_scores
      const miss = rs.miss_paths?.length ? rs.miss_paths.join(', ') : '(none)'
      const inst = q.retrieval_instrumentation
      const flags = [
        inst?.decoys != null ? `decoys:${inst.decoys}` : 'decoys:off',
        inst?.causal != null ? `causal:${inst.causal}` : 'causal:off',
        inst?.scope != null ? `scope:${inst.scope}` : 'scope:?',
      ].join(' ')
      console.log(
        `    Q${q.question_id} [${q.shape ?? '?'}] R@10=${fmt(rs.recall_at?.[10] ?? rs.recall_at_k)} first_must=${rs.first_gold_rank ?? '—'} ${flags} miss=[${miss}]`
      )
    }
  }

  if (write) {
    artifact.aggregate_scores = artifact.aggregate_scores ?? {}
    artifact.aggregate_scores.query = artifact.aggregate_scores.query ?? {}
    if (summary) artifact.aggregate_scores.query.graded_retrieval = summary
    if (cost) artifact.aggregate_scores.query.retrieval_cost = cost
    if (probeCoverage) artifact.aggregate_scores.query.probe_coverage = probeCoverage
    artifact.retrieval_evaluation = {
      graded_retrieval: summary,
      retrieval_cost: cost,
      probe_coverage: probeCoverage,
    }
    if (artifact.aggregate_scores.combined) {
      if (summary) artifact.aggregate_scores.combined.graded_retrieval = summary
      if (cost) artifact.aggregate_scores.combined.retrieval_cost = cost
    }
    if ((artifact.schema_version ?? 0) < 3) artifact.schema_version = 3
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8')
    console.error(`[replay] wrote ${artifactPath}`)
  }

  return { summary, cost, probeCoverage }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    process.exit(0)
  }

  if (args.all) {
    const rows = listArtifacts(args.suite || null)
    if (!rows.length) {
      console.error('[replay] no artifacts found under ~/.kb/evaluations/')
      process.exit(2)
    }
    console.log(`[replay] --all · ${rows.length} artifact(s)${args.suite ? ` · suite=${args.suite}` : ''}`)
    for (const row of rows) {
      const suiteId = args.suite || row.artifact?.run?.suite
      if (!suiteId) {
        console.error(`[replay] ${row.id}: no suite id — skip`)
        continue
      }
      try {
        scoreArtifact(row.artifact, row.file, suiteId, { write: args.write })
      } catch (e) {
        console.error(`[replay] ${row.id}: ${e instanceof Error ? e.message : e}`)
      }
    }
    if (args.write) {
      try {
        const { outPath } = writeResearchResultsTex(KB_REPO)
        console.error(`[replay] research results → ${outPath}`)
      } catch (e) {
        console.error(`[replay] research export skipped: ${e instanceof Error ? e.message : e}`)
      }
    }
    return
  }

  let artifactPath = args.artifactPath
  let artifact
  if (args.latest) {
    if (!args.suite) throw new Error('--latest requires --suite')
    const hit = listArtifacts(args.suite)[0]
    if (!hit) throw new Error(`no artifact found for suite ${args.suite}`)
    artifactPath = hit.file
    artifact = hit.artifact
  } else {
    if (!artifactPath) {
      usage()
      process.exit(1)
    }
    artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
  }

  const suiteId = args.suite || artifact?.run?.suite
  if (!suiteId) throw new Error('suite id unknown — pass --suite')
  scoreArtifact(artifact, artifactPath, suiteId, { write: args.write })
  if (args.write) {
    try {
      const { outPath } = writeResearchResultsTex(KB_REPO)
      console.error(`[replay] research results → ${outPath}`)
    } catch (e) {
      console.error(`[replay] research export skipped: ${e instanceof Error ? e.message : e}`)
    }
  }
}

try {
  main()
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
