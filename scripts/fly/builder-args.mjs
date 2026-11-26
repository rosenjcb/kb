#!/usr/bin/env node
// Emit the `fly machine run` flags that `fly machine run -c fly.builder.toml`
// *should* have inherited from the config but doesn't.
//
// WHY THIS FILE EXISTS
// -------------------
// The builder's only machine is created by `fly machine run`, not `fly deploy`.
// `fly machine run -c <file>` reads the app name and the image from the config
// and then ignores the rest of it: `primary_region`, the `[[vm]]` block, and
// the whole `[env]` table are NOT applied. Every caller therefore has to repeat
// those values on the command line, and for a long time three callers repeated
// them by hand:
//
//   * scripts/fly/deploy.sh          (BUILDER_VM_SIZE / BUILDER_VM_MEMORY / -e ...)
//   * .github/workflows/fly-deploy.yml  (--vm-size / --vm-memory / -e ... inline)
//   * the copy-pasteable commands in FLY_ORCHESTRATION.md and fly.builder.toml
//
// They drifted, repeatedly and expensively:
//   - shared-cpu-2x/4096 in CI vs performance-2x/4096 in the toml — cold builds
//     were OOM-killed on whichever tier a given path happened to use;
//   - the docs still said `--vm-size performance-2x --vm-memory 4096` while the
//     script had moved to performance-4x/8192;
//   - only COLD_BUILD_TIMEOUT and KB_EMBEDDER were forwarded, so every other
//     `[env]` key (SNAPSHOT_NO_REPOS, LOG_LEVEL, KB_HOME, …) silently fell back
//     to a code default on the scheduled machine but not on a deployed one.
//
// So: parse fly.builder.toml and forward what it declares. The toml becomes the
// single source of truth again, and right-sizing the builder is a one-line edit
// there instead of a four-file search-and-replace.
//
// It also enforces the one invariant that cannot be expressed in either file:
// builder and serving MUST share a region. A cross-region Tigris reader gets a
// stale LIST view of a freshly published prefix (every key head-objects 200
// while `aws s3 cp --recursive` copies nothing) and the demo crash-loops on
// "downloaded prefix … is incomplete". Observed for real — scheduler in `lax`,
// serving in `iad`. A mismatch is a hard failure here, before a machine exists.
//
// Usage:
//   node scripts/fly/builder-args.mjs           # flags, one per line (for `xargs`/`$(…)`)
//   node scripts/fly/builder-args.mjs --json    # {region, vmSize, vmMemory, env}
//   node scripts/fly/builder-args.mjs --region  # just the region
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const BUILDER_TOML = path.join(ROOT, 'fly.builder.toml')
const SERVE_TOML = path.join(ROOT, 'fly.toml')

/**
 * Strip comments and read a top-level `key = "value"` (or bare/numeric value)
 * that appears before any `[table]` header — i.e. the config's root table.
 * Deliberately tiny: this reads three known shapes out of two files we own, not
 * arbitrary TOML, and staying dependency-free keeps the Docker image and the CI
 * runner from needing a toml package just to start a machine.
 */
function readRootKey(text, key) {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    if (line.startsWith('[')) break // left the root table
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`))
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

/** Read `key = value` pairs out of the first `[name]` / `[[name]]` block. */
function readTable(text, name) {
  const out = {}
  let inside = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    if (/^\[\[?[^\]]+\]\]?$/.test(line)) {
      const header = line.replace(/^\[+|\]+$/g, '')
      if (inside) break // only the first such block
      inside = header === name
      continue
    }
    if (!inside) continue
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const builderText = fs.readFileSync(BUILDER_TOML, 'utf8')
const serveText = fs.readFileSync(SERVE_TOML, 'utf8')

const region = readRootKey(builderText, 'primary_region')
const serveRegion = readRootKey(serveText, 'primary_region')

if (!region) {
  console.error(`error: no primary_region in ${path.relative(ROOT, BUILDER_TOML)}.`)
  process.exit(1)
}
if (!serveRegion) {
  console.error(`error: no primary_region in ${path.relative(ROOT, SERVE_TOML)}.`)
  process.exit(1)
}
if (region !== serveRegion) {
  console.error(`error: builder region '${region}' (fly.builder.toml) != serving region '${serveRegion}' (fly.toml).
       Builder and serving must share a region, or Tigris serves the serving node a
       stale LIST view of a freshly published prefix and the demo crash-loops on
       "downloaded prefix … is incomplete". Fix one of the two files.`)
  process.exit(1)
}

const vm = readTable(builderText, 'vm')
const vmSize = vm.size || ''
const vmMemory = (vm.memory || '').replace(/mb$/i, '')
if (!vmSize || !vmMemory) {
  console.error(`error: could not read [[vm]] size/memory from ${path.relative(ROOT, BUILDER_TOML)}.`)
  process.exit(1)
}

// Every [env] key the toml declares. A deployed machine would get all of them;
// a `fly machine run` machine gets only what we pass here, so pass all of them.
const env = readTable(builderText, 'env')

const mode = process.argv[2] || ''
if (mode === '--json') {
  console.log(JSON.stringify({ region, vmSize, vmMemory: Number(vmMemory), env }, null, 2))
} else if (mode === '--region') {
  console.log(region)
} else {
  // One token per line so callers can read it into a bash array without
  // re-quoting: `mapfile -t args < <(node scripts/fly/builder-args.mjs)`.
  const out = ['--region', region, '--vm-size', vmSize, '--vm-memory', vmMemory]
  for (const [k, v] of Object.entries(env)) out.push('-e', `${k}=${v}`)
  console.log(out.join('\n'))
}
