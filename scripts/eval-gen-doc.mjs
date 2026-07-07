#!/usr/bin/env node
/**
 * Reproducible `kb docs generate` smoke on a named base (default dogfood).
 * Writes scratch + `artifact.json` under `~/.kb/evaluations/<run-name>/` (same layout family as eval-run.mjs).
 *
 * Usage (kb repo root, after `pnpm run build`):
 *   node scripts/eval-gen-doc.mjs [--base dogfood] [--label slug] [--skip-purge] [--reject-once "feedback"] [--out PATH]
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')

function evaluationsRoot() {
  return path.join(os.homedir(), '.kb', 'evaluations')
}

function sanitizeSlugPart(s) {
  const x = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return x || 'run'
}

function allocateRunName(label) {
  const leaf = sanitizeSlugPart(label || 'kb-docgen')
  const stem = `${leaf}-${dayjs().format('YYYY-MM-DD-HHmm')}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const root = evaluationsRoot()
  let name = stem
  let n = 0
  while (fs.existsSync(path.join(root, name))) {
    n += 1
    name = `${stem}-${n}`
  }
  return name
}

function sanitizeDocId(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'document'
  )
}

function kbSpawn(args, logPath) {
  const bin = path.join(KB_REPO, 'dist', 'bin', 'kb.js')
  const line = `node ${[bin, ...args].map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`
  if (logPath) fs.appendFileSync(logPath, `\n---\n${line}`, 'utf8')
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd: KB_REPO,
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env },
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  if (logPath) fs.appendFileSync(logPath, out, 'utf8')
  if (r.error) throw r.error
  if (r.status !== 0) {
    throw new Error(`kb exited ${r.status}: ${out.slice(0, 2000)}`)
  }
  return r.stdout || ''
}

function stripCliBanner(text) {
  const i = text.indexOf('{')
  if (i === -1) return text.trim()
  return text.slice(i).trim()
}

function kbJson(args, logPath) {
  const out = kbSpawn([...args, '--output', 'json'], logPath)
  return JSON.parse(stripCliBanner(out))
}

function tryDeleteDoc(base, docId, logPath) {
  try {
    kbSpawn(['docs', 'delete', docId, '--base', base, '--force'], logPath)
  } catch {
    /* missing doc ok */
  }
}

function wordCount(s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length
}

function scoreDocument(scenario, docMeta, viewText) {
  const title = docMeta.title || ''
  const checks = {
    title_len_ok: title.length > 0 && title.length <= 72,
    title_word_count_ok: wordCount(title) <= 12,
    title_no_trailing_sentence_period: !/[.!?]$/.test(title.trim()),
    has_references_heading: /(^|\n)## References\s*(\n|$)/.test(viewText),
    supporting_facts_positive: (docMeta.supportingFactCount ?? 0) >= 1,
    body_has_type_line: /(^|\n)Type:\s*\S+/.test(viewText),
  }
  const passed = Object.values(checks).filter(Boolean).length
  const total = Object.keys(checks).length
  const rubric_0_to_4 = Number(((passed / total) * 4).toFixed(2))
  return {
    scenario,
    checks,
    rubric_0_to_4,
    pass_all: passed === total,
    notes: [],
  }
}

const INTRO = {
  type: 'introduction',
  prompt:
    'What kb is and how it helps developers ship correct code faster with fewer revision cycles by grounding assistants in project facts.',
  purgeId: sanitizeDocId('KB intro eval smoke'),
  answers: [
    ['documentTitle', 'KB intro eval smoke'],
    ['audience', 'Developers and tech leads using AI coding tools who want repo-specific context.'],
    [
      'oneLineThesis',
      'kb is a local-first CLI knowledge base: facts and docs in SQLite-backed bases; query and generate so agents use team decisions.',
    ],
    [
      'mentalModel',
      'Bases isolate knowledge; submit/query facts; init ingests docs; docs generate uses a checklist then drafts with fact links.',
    ],
    ['boundaries', 'Not a hosted SaaS; not a full IDE; not automatic correctness without review.'],
    ['nextLinks', 'kb init; kb query; docs list; CLAUDE.md for agent workflow.'],
  ],
}

const HOWTO = {
  type: 'howto',
  prompt: 'How to initialize a kb base from one or more git repos with kb init, refresh with kb scan, and verify indexing.',
  purgeId: sanitizeDocId('kb init howto eval smoke'),
  answers: [
    ['documentTitle', 'kb init howto eval smoke'],
    ['goal', 'Create or refresh a project KB from one or more git repos so kb query returns grounded answers.'],
    ['prereqs', 'Node 24, kb on PATH, git remote URL(s), ~/.kb write access, optional LLM keys.'],
    [
      'steps',
      'kb init --base NAME --git <url> [--git <url2#branch>]; kb base use NAME; add another --git <url> and re-run init to fold in another repo; kb scan --base NAME to refresh; kb docs list --base NAME.',
    ],
    [
      'gotchas',
      'Large trees slow init; review rescan dry-run; use ci-* for throwaway bases; LLM required for LLM-heavy steps.',
    ],
    ['verify', 'docs list shows docs; kb query returns cited hits; init completes without errors.'],
  ],
}

function writeMarkdownExport(runDir, scenarioType, docId, meta, content) {
  const rel = `export-${scenarioType}.md`
  const safeTitle = String(meta.title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const hdr = [
    `<!-- eval-gen-doc: scenario=${scenarioType} document_id=${docId} -->`,
    safeTitle ? `<!-- title: ${safeTitle.replace(/-->/g, '')} -->` : null,
    '',
  ]
    .filter(Boolean)
    .join('\n')
  fs.writeFileSync(path.join(runDir, rel), `${hdr}\n${content ?? ''}`, 'utf8')
  return rel
}

function runScenario(base, spec, logPath, runDir) {
  const startArgs = ['docs', 'generate', spec.prompt, '--type', spec.type, '--base', base]
  const start = kbJson(startArgs, logPath)
  if (start.status !== 'accepted') throw new Error(`start failed: ${JSON.stringify(start)}`)
  const sessionId = start.generated.sessionId
  for (const [, text] of spec.answers) {
    kbJson(['docs', 'generate', '--resume', sessionId, '--answer', text, '--base', base], logPath)
  }
  const fin = kbJson(
    ['docs', 'generate', '--resume', sessionId, '--finalize', '--base', base],
    logPath
  )
  if (fin.status !== 'accepted') throw new Error(`finalize failed: ${JSON.stringify(fin)}`)
  const finGen = fin.generated
  if (finGen.status !== 'awaiting_review') {
    throw new Error(`expected awaiting_review after finalize, got: ${JSON.stringify(finGen)}`)
  }

  let lastDiff = null
  if (spec.rejectOnce) {
    const rej = kbJson(
      ['docs', 'generate', '--resume', sessionId, '--reject', spec.rejectOnce, '--base', base],
      logPath
    )
    if (rej.status !== 'accepted') throw new Error(`reject failed: ${JSON.stringify(rej)}`)
    lastDiff = rej.generated?.diff ?? null
    if (lastDiff) {
      fs.writeFileSync(path.join(runDir, `diff-${spec.type}.txt`), lastDiff, 'utf8')
    }
  }

  const acc = kbJson(
    ['docs', 'generate', '--resume', sessionId, '--accept', '--base', base],
    logPath
  )
  if (acc.status !== 'accepted') throw new Error(`accept failed: ${JSON.stringify(acc)}`)
  const gen = acc.generated
  const docId = gen.document.id
  const viewRaw = kbSpawn(['docs', 'view', docId, '--base', base, '--output', 'json'], logPath)
  const viewObj = JSON.parse(stripCliBanner(viewRaw))
  const docPayload = viewObj.document
  if (!docPayload) throw new Error('docs view json missing document')
  const content = typeof docPayload.content === 'string' ? docPayload.content : ''
  const meta = docPayload.metadata ?? {}
  const exportMarkdown = writeMarkdownExport(runDir, spec.type, docId, meta, content)
  const score = scoreDocument(
    spec.type,
    { ...gen, supportingFactCount: finGen.supportingFactCount },
    content
  )
  return {
    scenario: spec.type,
    session_id: sessionId,
    document_id: docId,
    title: gen.document.title,
    supporting_fact_count: finGen.supportingFactCount,
    finalize_response: finGen,
    accept_response: gen,
    reject_diff_file: spec.rejectOnce ? `diff-${spec.type}.txt` : null,
    export_markdown: exportMarkdown,
    score,
  }
}

function parseArgs(argv) {
  const out = {
    base: 'dogfood',
    label: null,
    skipPurge: false,
    rejectOnceGlobal: null,
    outFile: null,
    help: false,
  }
  if (argv.includes('--help') || argv.includes('-h')) out.help = true
  let i = 2
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--label') out.label = argv[++i]
    else if (a === '--skip-purge') out.skipPurge = true
    else if (a === '--reject-once') out.rejectOnceGlobal = argv[++i]
    else if (a === '--out') out.outFile = argv[++i]
    i++
  }
  return out
}

function printHelp() {
  console.log(`eval-gen-doc.mjs — docs generate smoke (artifact under ~/.kb/evaluations/<run>/)

  node scripts/eval-gen-doc.mjs [--base dogfood] [--label slug] [--skip-purge] [--reject-once "feedback"] [--out PATH]

Writes:
  ~/.kb/evaluations/<run>/artifact.json
  ~/.kb/evaluations/<run>/gen-doc.log
  ~/.kb/evaluations/<run>/export-introduction.md   (canonical stored markdown)
  ~/.kb/evaluations/<run>/export-howto.md
  ~/.kb/evaluations/<run>/README-exports.md       (absolute paths + how to open)
`)
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (!fs.existsSync(path.join(KB_REPO, 'dist', 'bin', 'kb.js'))) {
    console.error('[eval-gen-doc] run `pnpm run build` (or npm run build) from kb repo root first.')
    process.exit(1)
  }

  const runName = allocateRunName(args.label || 'kb-docgen')
  const runDir = path.join(evaluationsRoot(), runName)
  fs.mkdirSync(runDir, { recursive: true })
  const logPath = path.join(runDir, 'gen-doc.log')
  const outPath = args.outFile || path.join(runDir, 'artifact.json')

  fs.writeFileSync(logPath, `# eval-gen-doc ${dayjs().toISOString()}\nbase=${args.base}\n`, 'utf8')

  if (!args.skipPurge) {
    tryDeleteDoc(args.base, INTRO.purgeId, logPath)
    tryDeleteDoc(args.base, HOWTO.purgeId, logPath)
  }

  const documents = []
  let failed = false
  const rejectOnce = args.rejectOnceGlobal || undefined
  try {
    documents.push(runScenario(args.base, { ...INTRO, rejectOnce }, logPath, runDir))
    documents.push(runScenario(args.base, { ...HOWTO, rejectOnce }, logPath, runDir))
  } catch (e) {
    failed = true
    fs.appendFileSync(
      logPath,
      `\nERROR: ${e instanceof Error ? e.stack || e.message : e}\n`,
      'utf8'
    )
    console.error(e instanceof Error ? e.message : e)
  }

  const rubrics = documents.map(d => d.score.rubric_0_to_4)
  const meanRubric = rubrics.length ? rubrics.reduce((a, b) => a + b, 0) / rubrics.length : 0
  const allPass = documents.length === 2 && documents.every(d => d.score.pass_all)

  const exportFiles = documents.map(d => d.export_markdown).filter(Boolean)
  const readmeExports = path.join(runDir, 'README-exports.md')
  if (exportFiles.length > 0) {
    const absLines = exportFiles.map(f => `- \`${path.join(runDir, f)}\``)
    const openHint =
      process.platform === 'darwin'
        ? `\nmacOS:\n\n\`\`\`bash\nopen "${path.join(runDir, 'export-introduction.md')}"\n\`\`\`\n`
        : process.platform === 'win32'
          ? '\nWindows: start the paths above from Explorer or `code <path>`.\n'
          : `\nLinux:\n\n\`\`\`bash\nxdg-open "${path.join(runDir, 'export-introduction.md')}"\n\`\`\`\n`
    fs.writeFileSync(
      readmeExports,
      [
        '# Generated docs (eval-gen-doc)',
        '',
        'Markdown below is a **copy** of what is stored in the KB (`docs view` JSON `content`).',
        '',
        ...absLines,
        '',
        openHint,
      ].join('\n'),
      'utf8'
    )
  }

  const artifact = {
    schema_version: 1,
    evaluation_plan: 'EVALUATION.md (docs generate smoke; see eval-gen-doc.mjs)',
    run_label: args.label || runName,
    evaluation_kind: 'docs_generate_smoke',
    status: failed ? 'partial' : allPass ? 'complete' : 'partial',
    created_at: dayjs().toISOString(),
    run: {
      run_name: runName,
      evaluations_root: evaluationsRoot(),
      run_dir: runDir,
      base: args.base,
      kb_repo_root: KB_REPO,
      log_file: logPath,
      artifact_file: outPath,
      export_markdown_files: exportFiles,
      readme_exports: exportFiles.length ? path.basename(readmeExports) : null,
      commands_note:
        'Non-interactive kb docs generate (introduction + howto) with fixed answers; optional purge of deterministic doc ids before run.',
    },
    documents,
    aggregate_scores: {
      docs_generate: {
        mean_rubric_0_to_4: Number(meanRubric.toFixed(3)),
        pass_all_automated_checks: allPass && !failed,
        scenarios_completed: documents.length,
      },
    },
    qualitative_findings: [
      'Rubric is heuristic (title length, References section, fact count). Tune checks in scripts/eval-gen-doc.mjs as the product improves.',
      failed ? 'Run ended with errors — see gen-doc.log.' : null,
    ].filter(Boolean),
  }

  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8')
  console.error(`[eval-gen-doc] wrote ${outPath}`)
  console.error(`[eval-gen-doc] log ${logPath}`)
  if (exportFiles.length) {
    console.error(`[eval-gen-doc] exports ${exportFiles.map(f => path.join(runDir, f)).join(' ')}`)
    console.error(`[eval-gen-doc] see ${readmeExports}`)
  }
  process.exit(failed ? 1 : 0)
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exit(1)
}
