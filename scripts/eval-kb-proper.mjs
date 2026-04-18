#!/usr/bin/env node
/**
 * Repeatable EVALUATION.md harvest: disposable ci-* base, kb init --non-interactive,
 * canonical kb query x8, metrics + artifact under evaluation/runs/.
 *
 * Usage (repo root):
 *   npm run build:cli
 *   npm run eval:kb-proper -- --base ci-eval-20260418-my-run [--label my-run] [--hypothesis "..."] [--workdir /tmp/kb-eval-xyz]
 *
 * --scores-file optional JSON: [ { "correctness", "usefulness", "specificity", "evidence_handling", "notes" }, ... x8 ]
 * Without it, scores are 0 with notes asking for manual rubric per EVALUATION.md.
 *
 * Uses default KB home (~/.kb): KB_HOME is stripped from the child environment.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

const CANONICAL_QUESTIONS = [
  'What is this project for, and what are the main things kb can do?',
  'How does kb init work at a high level, including the major passes?',
  'Where do KB documents live, and how are active/default bases selected?',
  'How does retrieval work, including hybrid retrieval and graph involvement?',
  'What does kb chat do when retrieval is weak or incomplete?',
  'What commands should a contributor use during normal dogfood development in this repo?',
  'What special repo rules apply to KB documentation and persistence?',
  'How can someone inspect the graph and run telemetry/log comparisons?',
]

function parseArgs(argv) {
  const out = {
    base: null,
    label: null,
    hypothesis: null,
    workdir: null,
    outFile: null,
    scoresFile: null,
    skipInit: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--label') out.label = argv[++i]
    else if (a === '--hypothesis') out.hypothesis = argv[++i]
    else if (a === '--workdir') out.workdir = argv[++i]
    else if (a === '--out') out.outFile = argv[++i]
    else if (a === '--scores-file') out.scoresFile = argv[++i]
    else if (a === '--skip-init') out.skipInit = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function printHelp() {
  console.log(`eval-kb-proper.mjs — EVALUATION.md automated harvest

Options:
  --base <name>        Required unless you rely on auto (ci-eval-YYYYMMDD-HHmmss-auto)
  --label <slug>       Artifact filename slug (default: same as base or "eval")
  --hypothesis <text>  Stored in artifact
  --workdir <path>     Scratch dir for query JSON etc. (default: /tmp/kb-eval-<timestamp>)
  --out <path>         Override output JSON path
  --scores-file <path> Optional JSON array of 8 score objects (rubric axes + notes)
  --skip-init          Only re-build artifact from existing --workdir (expects q1..q8.json, docs.json, graph.txt, logs.txt, init.log)
  --help
`)
}

function kbEnv() {
  const env = { ...process.env }
  env.KB_HOME = undefined
  return env
}

function kb(repo, args, opts = {}) {
  const bin = path.join(repo, 'dist/bin/kb.js')
  return execSync(`node "${bin}" ${args}`, {
    encoding: 'utf8',
    env: kbEnv(),
    cwd: repo,
    maxBuffer: 50 * 1024 * 1024,
    stdio: opts.capture === false ? 'inherit' : undefined,
    ...opts,
  })
}

function stripCliBanner(text) {
  const i = text.indexOf('{')
  if (i === -1) return text.trim()
  return text.slice(i)
}

function parseJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return JSON.parse(stripCliBanner(raw))
}

function extractInitAcceptedObject(logText) {
  const anchor = '"status": "accepted"'
  let pos = logText.lastIndexOf(anchor)
  while (pos !== -1) {
    const start = logText.lastIndexOf('{', pos)
    if (start === -1) break
    let depth = 0
    for (let i = start; i < logText.length; i++) {
      const ch = logText[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const slice = logText.slice(start, i + 1)
          try {
            const o = JSON.parse(slice)
            if (o.status === 'accepted' && Array.isArray(o.completedCycles)) return o
          } catch {
            /* continue */
          }
          break
        }
      }
    }
    pos = logText.lastIndexOf(anchor, start - 1)
  }
  return null
}

function parseGraphCounts(graphText) {
  const em = /Entities:\s*(\d+)/.exec(graphText)
  const rm = /Relationships:\s*(\d+)/.exec(graphText)
  return {
    entities: em ? Number(em[1]) : 0,
    relationships: rm ? Number(rm[1]) : 0,
  }
}

function parseLatestInitRunId(logsText) {
  const lines = logsText.split('\n').filter(l => l.trim().startsWith('run-'))
  if (lines.length === 0) return null
  const first = lines[0].trim().split(/\s+/)[0]
  return first || null
}

function git(repo, args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', cwd: repo }).trim()
  } catch {
    return 'unknown'
  }
}

function summarizeRaw(parsed) {
  const data = parsed.data ?? {}
  const results = data.results ?? []
  const ans =
    typeof parsed.answer === 'string'
      ? parsed.answer
      : typeof data.answer === 'string'
        ? data.answer
        : undefined
  return {
    status: parsed.status,
    result_count: results.length,
    retrieval: data.retrieval ?? null,
    answer_preview: typeof ans === 'string' ? ans.slice(0, 500) : null,
    provenance: Array.isArray(parsed.provenance) ? parsed.provenance : [],
  }
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const stamp = dayjs().format('YYYYMMDD-HHmmss')
  const base = args.base || `ci-eval-${stamp}-auto`
  const label = args.label || base.replace(/^ci-eval-/, '') || 'eval'
  const workdir = args.workdir || path.join('/tmp', `kb-eval-${stamp}`)
  const hypothesis =
    args.hypothesis ||
    'Automated EVALUATION.md harvest: non-interactive init + canonical kb query suite on disposable base.'

  if (!args.skipInit) {
    fs.mkdirSync(workdir, { recursive: true })
  } else if (!fs.existsSync(workdir)) {
    console.error(`--skip-init requires existing --workdir: ${workdir}`)
    process.exit(1)
  }

  const kbBin = path.join(REPO, 'dist/bin/kb.js')
  if (!fs.existsSync(kbBin)) {
    console.error('Missing dist/bin/kb.js — run: npm run build:cli')
    process.exit(1)
  }

  if (!args.skipInit) {
    console.error(`[eval] workdir ${workdir}`)
    console.error(`[eval] init --base ${base}`)
    const initLog = kb(REPO, `init --base ${base} --non-interactive --debug`)
    fs.writeFileSync(path.join(workdir, 'init.log'), initLog, 'utf8')

    console.error(`[eval] kb default ${base}`)
    kb(REPO, `default ${base}`, { stdio: 'inherit' })

    console.error('[eval] docs list')
    const docsOut = kb(REPO, `docs list --base ${base} --output json`)
    fs.writeFileSync(path.join(workdir, 'docs.json'), stripCliBanner(docsOut), 'utf8')

    console.error('[eval] graph')
    const graphOut = kb(REPO, 'graph')
    fs.writeFileSync(path.join(workdir, 'graph.txt'), graphOut, 'utf8')

    console.error('[eval] logs list')
    const logsOut = kb(REPO, 'logs list --command init --limit 3')
    fs.writeFileSync(path.join(workdir, 'logs.txt'), logsOut, 'utf8')

    let q = 1
    for (const question of CANONICAL_QUESTIONS) {
      console.error(`[eval] query ${q}/8`)
      const escaped = question.replace(/"/g, '\\"')
      const out = kb(REPO, `query "${escaped}" --base ${base} --output json`)
      fs.writeFileSync(path.join(workdir, `q${q}.json`), out, 'utf8')
      q++
    }
  }

  const initLog = fs.readFileSync(path.join(workdir, 'init.log'), 'utf8')
  const initJson = extractInitAcceptedObject(initLog)
  const graphText = fs.readFileSync(path.join(workdir, 'graph.txt'), 'utf8')
  const graphCounts = parseGraphCounts(graphText)
  const logsText = fs.readFileSync(path.join(workdir, 'logs.txt'), 'utf8')
  const initRunId = parseLatestInitRunId(logsText)
  const docsList = parseJsonFile(path.join(workdir, 'docs.json'))

  let manualScores = null
  if (args.scoresFile) {
    manualScores = JSON.parse(fs.readFileSync(path.resolve(args.scoresFile), 'utf8'))
    if (!Array.isArray(manualScores) || manualScores.length !== 8) {
      console.error('--scores-file must be a JSON array of length 8')
      process.exit(1)
    }
  }

  const query_evaluation = []
  for (let n = 1; n <= 8; n++) {
    const parsed = parseJsonFile(path.join(workdir, `q${n}.json`))
    const data = parsed.data ?? {}
    const results = data.results ?? []
    const retrieval = data.retrieval
      ? {
          method: data.retrieval.method ?? null,
          detail: data.retrieval.detail ?? null,
          confidence:
            data.retrieval.checkpoints?.[0]?.confidence ?? data.retrieval.confidence ?? null,
        }
      : { method: null, detail: null, confidence: null }
    const answer =
      typeof parsed.answer === 'string'
        ? parsed.answer
        : typeof data.answer === 'string'
          ? data.answer
          : null
    const prov = Array.isArray(parsed.provenance)
      ? parsed.provenance
      : results.map(r => r.metadata?.id).filter(Boolean)

    const ms = manualScores?.[n - 1]
    const scores = ms
      ? {
          correctness: Number(ms.correctness),
          usefulness: Number(ms.usefulness),
          specificity: Number(ms.specificity),
          evidence_handling: Number(ms.evidence_handling),
        }
      : { correctness: 0, usefulness: 0, specificity: 0, evidence_handling: 0 }
    const notes = ms?.notes?.trim()
      ? ms.notes
      : 'Rubric scores not supplied — fill manually per EVALUATION.md (or re-run with --scores-file).'

    query_evaluation.push({
      question_id: n,
      question: CANONICAL_QUESTIONS[n - 1],
      result_count: results.length,
      retrieval,
      answer_excerpt: answer ? answer.slice(0, 280) : null,
      provenance: prov,
      raw_query_output: summarizeRaw(parsed),
      scores,
      notes,
    })
  }

  const mC = mean(query_evaluation.map(q => q.scores.correctness))
  const mU = mean(query_evaluation.map(q => q.scores.usefulness))
  const mS = mean(query_evaluation.map(q => q.scores.specificity))
  const mE = mean(query_evaluation.map(q => q.scores.evidence_handling))
  const pr =
    query_evaluation.filter(q => q.scores.correctness >= 3 && q.scores.usefulness >= 3).length /
    query_evaluation.length

  const dateSlug = dayjs().format('YYYY-MM-DD')
  const outPath =
    args.outFile ||
    path.join(
      REPO,
      'evaluation',
      'runs',
      `${dateSlug}-${label.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`
    )

  const branch = git(REPO, 'branch --show-current')
  const commit = git(REPO, 'rev-parse HEAD')

  const artifact = {
    schema_version: 1,
    evaluation_plan: 'EVALUATION.md',
    run_label: label,
    status: 'partial',
    created_at: dayjs().toISOString(),
    repository: {
      name: 'kb',
      branch,
      commit,
    },
    hypothesis,
    run: {
      base,
      mode: 'non_interactive_cli_init',
      commands: [
        'npm run build:cli',
        `node dist/bin/kb.js init --base ${base} --non-interactive --debug`,
        `node dist/bin/kb.js default ${base}`,
        `node dist/bin/kb.js docs list --base ${base} --output json`,
        'node dist/bin/kb.js graph',
        'node dist/bin/kb.js logs list --command init --limit 3',
        `node dist/bin/kb.js query "<each canonical question>" --base ${base} --output json`,
      ],
      workdir,
      init_result: {
        status: initJson?.status ?? 'unknown',
        written_docs: initJson?.writtenDocIds?.length ?? 0,
        written_doc_ids: initJson?.writtenDocIds ?? [],
        init_run_id: initRunId,
        init_run_id_note: initRunId ? null : 'Could not parse init run id from kb logs table.',
        docs_list: docsList,
        graph_summary: {
          entities: graphCounts.entities,
          relationships: graphCounts.relationships,
        },
      },
    },
    question_set: CANONICAL_QUESTIONS,
    query_evaluation,
    chat_evaluation: {
      status: 'not_captured',
      notes:
        'Batch automation: kb chat transcripts not captured. Follow EVALUATION.md Phase 3 for interactive chat when a complete run is required.',
    },
    aggregate_scores: {
      query: {
        mean_correctness: Number(mC.toFixed(3)),
        mean_usefulness: Number(mU.toFixed(3)),
        mean_specificity: Number(mS.toFixed(3)),
        mean_evidence_handling: Number(mE.toFixed(3)),
        pass_rate_correctness_and_usefulness_at_least_3: Number(pr.toFixed(3)),
      },
      chat: {
        mean_correctness: 0,
        mean_usefulness: 0,
        mean_specificity: 0,
        mean_evidence_handling: 0,
        pass_rate_correctness_and_usefulness_at_least_3: 0,
      },
      combined: {
        mean_correctness: Number(mC.toFixed(3)),
        mean_usefulness: Number(mU.toFixed(3)),
        mean_specificity: Number(mS.toFixed(3)),
        mean_evidence_handling: Number(mE.toFixed(3)),
        pass_rate_correctness_and_usefulness_at_least_3: Number(pr.toFixed(3)),
      },
    },
    qualitative_findings: [
      manualScores
        ? 'Scores supplied via --scores-file.'
        : 'Scores left at zero placeholder until manual rubric or --scores-file.',
      `Scratch JSON under ${workdir} (safe to delete after archiving the artifact).`,
    ],
    next_improvement_areas: [
      'Optional: extend script to ingest kb chat logs for status=complete.',
      'Optional: read init token totals from ~/.kb/logs for init_result telemetry fields.',
    ],
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8')
  console.error(`[eval] wrote ${outPath}`)
}

main()
