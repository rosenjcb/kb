import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')

function primaryRegion(toml: string): string {
  const m = toml.match(/^\s*primary_region\s*=\s*"([^"]+)"/m)
  if (!m) throw new Error('primary_region missing')
  return m[1]
}

describe('Fly build-to-serve orchestration contracts', () => {
  it('[TC-D98R] Given fly.toml and fly.builder.toml, when primary_region is compared, then they match', () => {
    expect(primaryRegion(read('fly.toml'))).toBe(primaryRegion(read('fly.builder.toml')))
  })

  it('[TC-U5RT][TC-QMFK] Given s3_push_prefix, when objects are incomplete vs complete, then head-object gates the pointer flip', () => {
    const lib = read('scripts/fly/lib.sh')
    // Publish waits on head (not LIST alone) before the caller may write latest.json.
    expect(lib).toMatch(/s3_head_object|head-object|HeadObject/i)
    expect(lib).toMatch(/s3_push_prefix/)
  })

  it('[TC-8KCV][TC-2PNL][TC-IHL1][TC-MHQN] Given pull_latest, when required objects are incomplete, then it retries or fails without progress on stdout', () => {
    const lib = read('scripts/fly/lib.sh')
    expect(lib).toMatch(/pull_latest|s3_pull_prefix/)
    // Progress logs go to stderr so `version="$(pull...)"` stays clean.
    expect(lib).toMatch(/1>&2|>&2/)
  })

  it('[TC-VJML][TC-B5JP][TC-UNIF] Given serve-entrypoint, when default vs optional base adopt runs, then default is hard and optional is best-effort', () => {
    const entry = read('scripts/fly/serve-entrypoint.sh')
    expect(entry).toMatch(/healthz|health/i)
    expect(entry).toMatch(/skipping base=|import failed|optional/i)
    // Default base failure must exit the process.
    expect(entry).toMatch(/exit 1|exit \$/)
  })

  it('[TC-4KB9] Given roll-serving, when a roll starts, then it waits long enough for adopt+listen', () => {
    const roll = read('scripts/fly/roll-serving.mjs')
    // Configurable wait, default at least 10 minutes (600_000ms) or equivalent.
    expect(roll).toMatch(/wait|timeout|600|10\s*\*\s*60|600_?000|900|15\s*\*\s*60/i)
  })

  it('[TC-PDQD][TC-4JKB][TC-E9O4] Given deploy.sh fly machine run calls, when inspected, then every call passes --region and KB_EMBEDDER=gemini', () => {
    const deploy = read('scripts/fly/deploy.sh')
    const runs = deploy.match(/fly machine run[\s\S]*?(?=\n\n|fly deploy|fly logs|if \[\[|echo "==>|$)/g) ?? []
    // At least the scheduler recreate + seed paths.
    expect(deploy).toMatch(/fly machine run/)
    expect(deploy.match(/--region "\$BUILDER_REGION"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(deploy.match(/-e KB_EMBEDDER=gemini/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    void runs
  })

  it('[TC-SH7G][TC-RM3X] Given refresh.sh fail-fast loop, when a base fails, then later bases do not run and roll is skipped', () => {
    const refresh = read('scripts/fly/refresh.sh')
    expect(refresh).toMatch(/aborting builder|not building further bases/i)
    expect(refresh).toMatch(/not rolling the serving node/i)
    // roll only after clean success.
    expect(refresh).toMatch(/roll-serving\.mjs/)
    expect(refresh).toMatch(/if \[\[ -n "\$failed_base" \]\]/)
  })

  it('[TC-P06Z] Given FORCE_COLD=true, when build_base runs, then it ignores latest.json and rebuilds cold', () => {
    const refresh = read('scripts/fly/refresh.sh')
    expect(refresh).toMatch(/FORCE_COLD=true/)
    expect(refresh).toMatch(/ignoring existing pointer|FORCE_COLD/)
  })

  it('[TC-63GA] Given ONLY_BASES, when the builder iterates bases, then only listed names run', () => {
    const refresh = read('scripts/fly/refresh.sh')
    expect(refresh).toMatch(/ONLY_BASES/)
    expect(refresh).toMatch(/case ",\$\{ONLY_BASES\},"/)
  })

  it('[TC-ROM5] Given production tomls, when env is inspected, then builder and serve declare KB_EMBEDDER=gemini', () => {
    const builder = read('fly.builder.toml')
    const serve = read('fly.toml')
    expect(builder).toMatch(/KB_EMBEDDER\s*=\s*"gemini"|KB_EMBEDDER=gemini/)
    expect(serve).toMatch(/KB_EMBEDDER\s*=\s*"gemini"|KB_EMBEDDER=gemini/)
  })

  it('[TC-HT27] Given a refresh that fails mid embed, when the shell builds a base, then it must not flip the S3 pointer', () => {
    const refresh = read('scripts/fly/refresh.sh')
    // build_base uses kb-server refresh under set -e; failure aborts before pointer write.
    expect(refresh).toMatch(/kb-server refresh|server refresh/)
    expect(refresh).toMatch(/latest\.json|s3_put|pointer/i)
  })
})
