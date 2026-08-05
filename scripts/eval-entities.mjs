#!/usr/bin/env node
/**
 * Dump harvested ontology entities from an eval session index.
 *
 * Reads `~/.kb/sessions/<base>/.kb-index.sqlite` (`entities` / `entity_aliases` /
 * `entity_edges`) without running queries or control. Use after `eval-index` scan /
 * `pnpm run eval` to inspect what the entity-index cycle harvested.
 *
 * Reports edges as well as entities: a registry with entities but no relationship
 * edges is a bag of names, not a graph, and edge-derived retrieval lanes cannot fire
 * against it. The pipeline version says which extraction built the index — a base
 * behind the running code explains a thin registry on its own.
 *
 * Usage (kb repo root):
 *   pnpm run eval:entities -- --base eval-kb
 *   pnpm run eval:entities -- --suite kb
 *   pnpm run eval:entities -- --all-suites
 *   pnpm run eval:entities -- --suite kb --json --samples 10
 *   pnpm run eval:entities -- --list-suites
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { derivedBase, listSuiteIds, sanitizeSlugPart } from './eval-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KB_REPO = path.resolve(__dirname, '..')
const DEFAULT_SAMPLES = 5

function sessionsRoot() {
  return path.join(os.homedir(), '.kb', 'sessions')
}

function indexPathForBase(base) {
  return path.join(sessionsRoot(), base, '.kb-index.sqlite')
}

function printUsage(stream = process.stderr) {
  stream.write(`Usage: node scripts/eval-entities.mjs [options]

Dump harvested entities from eval session indexes (no query / no control).

Options:
  --base NAME          Session base under ~/.kb/sessions/<NAME>
  --suite ID           Suite id → base eval-{id} (from eval/suites/*.yaml)
  --all-suites         Report every suite id under eval/suites/
  --list-suites        Print suite ids from eval/suites/ and exit
  --samples N          Sample canonical names per kind (default ${DEFAULT_SAMPLES}; 0 = none)
  --json               Emit JSON instead of a human table
  --help, -h           Show this help

Examples:
  pnpm run eval:entities -- --base eval-kb
  pnpm run eval:entities -- --suite raylib --samples 8
  pnpm run eval:entities -- --all-suites --json

Harvest-only workflow (reindex elsewhere, then report):
  pnpm exec tsx scripts/eval-index.ts scan --base eval-kb
  pnpm run eval:entities -- --suite kb
`)
}

function parseArgs(argv) {
  const out = {
    bases: [],
    suites: [],
    allSuites: false,
    listSuites: false,
    samples: DEFAULT_SAMPLES,
    json: false,
    help: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    // pnpm sometimes forwards a bare `--` separator (`pnpm run eval:entities -- --suite kb`)
    if (a === '--') continue
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--json') out.json = true
    else if (a === '--all-suites') out.allSuites = true
    else if (a === '--list-suites') out.listSuites = true
    else if (a === '--base') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--base requires a name')
      out.bases.push(v.trim())
    } else if (a === '--suite') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--suite requires an id')
      out.suites.push(v.trim())
    } else if (a === '--samples') {
      const v = argv[++i]
      const n = Number.parseInt(v ?? '', 10)
      if (!Number.isFinite(n) || n < 0) throw new Error('--samples requires a non-negative integer')
      out.samples = n
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`)
    } else {
      throw new Error(`Unexpected argument: ${a}`)
    }
  }
  return out
}

/**
 * Resolve which bases to report.
 * @returns {{ targets: Array<{ suiteId: string|null, base: string }>, knownSuites: string[] }}
 */
function resolveTargets(args) {
  const knownSuites = listSuiteIds()
  const targets = []
  const seen = new Set()

  const push = (suiteId, base) => {
    const key = base
    if (seen.has(key)) return
    seen.add(key)
    targets.push({ suiteId, base })
  }

  if (args.allSuites) {
    if (knownSuites.length === 0) {
      throw new Error(`[eval-entities] no suite YAML files under ${path.join(KB_REPO, 'eval', 'suites')}`)
    }
    for (const id of knownSuites) push(id, derivedBase(id))
  }

  for (const suiteId of args.suites) {
    if (!knownSuites.includes(suiteId)) {
      throw new Error(
        `[eval-entities] unknown suite "${suiteId}". Known: ${knownSuites.length ? knownSuites.join(', ') : '(none)'}`
      )
    }
    push(suiteId, derivedBase(suiteId))
  }

  for (const base of args.bases) {
    const slug = sanitizeSlugPart(base.replace(/^eval-/, ''))
    const matchingSuite = knownSuites.includes(slug) ? slug : null
    push(matchingSuite, base)
  }

  return { targets, knownSuites }
}

/**
 * @param {string} dbPath
 * @param {number} samples
 */
function loadEntityReport(dbPath, samples) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entities'`)
      .get()
    if (!table) {
      return {
        ok: false,
        error: 'missing entities table (index predates entity harvest, or migrations not applied)',
        total: 0,
        aliasCount: 0,
        byKind: [],
        byEdgeType: [],
        relationshipEdges: 0,
        pipelineVersion: 0,
      }
    }

    const totalRow = db
      .prepare('SELECT COUNT(*) AS n FROM entities WHERE tombstoned_at IS NULL')
      .get()
    const total = Number(totalRow?.n ?? 0)

    let aliasCount = 0
    const aliasTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entity_aliases'`)
      .get()
    if (aliasTable) {
      aliasCount = Number(db.prepare('SELECT COUNT(*) AS n FROM entity_aliases').get()?.n ?? 0)
    }

    const kindRows = db
      .prepare(
        `SELECT kind, COUNT(*) AS count
         FROM entities
         WHERE tombstoned_at IS NULL
         GROUP BY kind
         ORDER BY count DESC, kind ASC`
      )
      .all()

    const byKind = kindRows.map(row => {
      const kind = String(row.kind)
      const count = Number(row.count)
      let sample = []
      if (samples > 0 && count > 0) {
        sample = db
          .prepare(
            `SELECT canonical_name AS name
             FROM entities
             WHERE tombstoned_at IS NULL AND kind = ?
             ORDER BY canonical_name ASC
             LIMIT ?`
          )
          .all(kind, samples)
          .map(r => String(r.name))
      }
      return { kind, count, sample }
    })

    // Edge counts by type. Reporting only entities is what hid a registry with a
    // healthy entity count and no relationship edges at all — a bag of names rather
    // than a graph. `distinct_from` is excluded from the headline because it is
    // written by the collision screen, not harvested.
    let byEdgeType = []
    const edgeTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entity_edges'`)
      .get()
    if (edgeTable) {
      byEdgeType = db
        .prepare(
          `SELECT edge_type AS type, COUNT(*) AS count
           FROM entity_edges
           GROUP BY edge_type
           ORDER BY count DESC, edge_type ASC`
        )
        .all()
        .map(row => ({ type: String(row.type), count: Number(row.count) }))
    }
    const relationshipEdges = byEdgeType
      .filter(e => e.type !== 'distinct_from')
      .reduce((sum, e) => sum + e.count, 0)

    // Which extraction pipeline built this index — a base far behind the running code
    // explains a low entity/edge count better than any harvester theory.
    let pipelineVersion = 0
    const stateTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='index_state'`)
      .get()
    if (stateTable) {
      const rows = db
        .prepare(`SELECT value FROM index_state WHERE key LIKE 'pipeline_version%'`)
        .all()
      for (const row of rows) {
        const parsed = Number.parseInt(String(row.value), 10)
        if (Number.isFinite(parsed)) pipelineVersion = Math.max(pipelineVersion, parsed)
      }
    }

    return { ok: true, total, aliasCount, byKind, byEdgeType, relationshipEdges, pipelineVersion }
  } finally {
    db.close()
  }
}

function reportForTarget(target, samples) {
  const dbPath = indexPathForBase(target.base)
  const base = {
    suite: target.suiteId,
    base: target.base,
    index: dbPath,
  }
  if (!fs.existsSync(dbPath)) {
    return {
      ...base,
      present: false,
      error: 'index not found',
      total: 0,
      aliasCount: 0,
      byKind: [],
      byEdgeType: [],
      relationshipEdges: 0,
      pipelineVersion: 0,
    }
  }
  const loaded = loadEntityReport(dbPath, samples)
  return {
    ...base,
    present: true,
    ...loaded,
  }
}

function printHuman(reports, { samples }) {
  for (const r of reports) {
    const label = r.suite ? `${r.suite} → ${r.base}` : r.base
    console.log(`\n=== ${label} ===`)
    console.log(`index: ${r.index}`)
    if (!r.present) {
      console.log(`status: missing (${r.error})`)
      continue
    }
    if (!r.ok) {
      console.log(`status: error (${r.error})`)
      continue
    }
    console.log(
      `entities: ${r.total}   aliases: ${r.aliasCount}   ` +
        `relationship edges: ${r.relationshipEdges}   pipeline: v${r.pipelineVersion || '?'}`
    )
    if (r.byEdgeType.length > 0) {
      console.log(`edges: ${r.byEdgeType.map(e => `${e.type}=${e.count}`).join('  ')}`)
    }
    if (r.total > 0 && r.relationshipEdges === 0) {
      console.log('⚠  no relationship edges — entities are unconnected (edge-derived lanes cannot fire)')
    }
    if (r.byKind.length === 0) {
      console.log('(empty registry — run eval-index scan / entity-index cycle)')
      continue
    }
    const kindW = Math.max(4, ...r.byKind.map(k => k.kind.length))
    const countW = Math.max(5, ...r.byKind.map(k => String(k.count).length))
    console.log(`${'kind'.padEnd(kindW)}  ${'count'.padStart(countW)}  samples`)
    for (const k of r.byKind) {
      const sample =
        samples > 0 && k.sample.length
          ? k.sample.join(', ') + (k.count > k.sample.length ? ', …' : '')
          : '—'
      console.log(`${k.kind.padEnd(kindW)}  ${String(k.count).padStart(countW)}  ${sample}`)
    }
  }
  console.log('')
}

function main() {
  let args
  try {
    args = parseArgs(process.argv)
  } catch (err) {
    console.error(`[eval-entities] ${err instanceof Error ? err.message : String(err)}`)
    printUsage()
    process.exit(1)
  }

  if (args.help) {
    printUsage(process.stdout)
    process.exit(0)
  }

  if (args.listSuites) {
    const ids = listSuiteIds()
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ suites: ids }, null, 2)}\n`)
    } else {
      for (const id of ids) console.log(id)
    }
    process.exit(ids.length ? 0 : 1)
  }

  if (!args.allSuites && args.suites.length === 0 && args.bases.length === 0) {
    console.error('[eval-entities] pass --base, --suite, and/or --all-suites (or --list-suites)')
    printUsage()
    process.exit(1)
  }

  let targets
  try {
    ;({ targets } = resolveTargets(args))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const reports = targets.map(t => reportForTarget(t, args.samples))

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          samples: args.samples,
          reports,
        },
        null,
        2
      )}\n`
    )
  } else {
    printHuman(reports, { samples: args.samples })
  }

  const explicit = !args.allSuites
  const hardFail = reports.some(r => {
    if (explicit) return !r.present || !r.ok
    return false
  })
  const allMissing = reports.every(r => !r.present)
  if (hardFail || allMissing) process.exit(1)
}

main()
