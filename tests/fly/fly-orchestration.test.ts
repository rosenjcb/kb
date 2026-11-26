import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  it('[TC-8KCV][TC-2PNL][TC-IHL1][TC-MHQN][TC-OUBI] Given pull_latest, when required objects are incomplete or genuinely absent, then it retries or fails without progress on stdout', () => {
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

  it('[TC-PDQD][TC-4JKB][TC-E9O4][TC-WQ3F] Given every fly machine run caller, when inspected, then all machine config comes from builder-args.mjs and none is hand-copied', () => {
    const deploy = read('scripts/fly/deploy.sh')
    const bootstrap = read('scripts/fly/bootstrap.sh')
    const workflow = read('.github/workflows/fly-deploy.yml')

    for (const [name, src] of [
      ['deploy.sh', deploy],
      ['bootstrap.sh', bootstrap],
      ['fly-deploy.yml', workflow],
    ] as const) {
      // Every caller sources the args from the shim...
      expect(src, `${name} must read builder args from the shim`).toMatch(
        /builder-args\.mjs/,
      )
      // ...and forwards them on every machine-creating call.
      const runs = src.match(/fly(?:ctl)? machine run[^\n]*(?:\n[^\n]*)*?refresh\.sh/g) ?? []
      expect(runs.length, `${name} should have at least one fly machine run`).toBeGreaterThanOrEqual(1)
      for (const run of runs) {
        expect(run, `${name}: every fly machine run must forward the shim's args`).toMatch(
          /\$\{?(?:BUILDER_ARGS|builder_args)(?:\[@\])?\}?|builder-args\.mjs/,
        )
      }
      // A second hand-written copy of the vm size or region is exactly the
      // drift this shim exists to prevent — it happened twice before.
      expect(src, `${name} must not hard-code a vm size`).not.toMatch(
        /--vm-size\s+(?:performance|shared-cpu)-/,
      )
      expect(src, `${name} must not hard-code a region`).not.toMatch(/--region\s+[a-z]{3}\b/)
    }
  })

  it('[TC-E9O4][TC-WQ3F] Given builder-args.mjs, when run, then it emits the toml region, vm size/memory, and every [env] key', () => {
    const out = execFileSync(process.execPath, ['scripts/fly/builder-args.mjs'], {
      cwd: root,
      encoding: 'utf8',
    })
    const tokens = out.trim().split('\n')
    const flag = (name: string) => tokens[tokens.indexOf(name) + 1]

    expect(flag('--region')).toBe(primaryRegion(read('fly.builder.toml')))
    expect(flag('--vm-size')).toMatch(/^(performance|shared-cpu)-\d+x$/)
    expect(Number(flag('--vm-memory'))).toBeGreaterThan(0)
    // KB_EMBEDDER is load-bearing (builder and serving must share a vector
    // space), and was previously one of only two [env] keys forwarded by hand.
    expect(tokens).toContain('KB_EMBEDDER=gemini')
    // The whole [env] table now comes through, not a remembered subset.
    const builderToml = read('fly.builder.toml')
    const envBlock = builderToml.slice(builderToml.indexOf('[env]'))
    for (const m of envBlock.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"/gm)) {
      expect(tokens, `[env] ${m[1]} must be forwarded`).toContain(`${m[1]}=${m[2]}`)
    }
  })

  it('[TC-M8ZK] Given mismatched primary_region, when builder-args.mjs runs, then it fails loudly instead of placing a cross-region machine', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fly-args-'))
    mkdirSync(path.join(dir, 'scripts', 'fly'), { recursive: true })
    copyFileSync(
      path.join(root, 'scripts/fly/builder-args.mjs'),
      path.join(dir, 'scripts/fly/builder-args.mjs'),
    )
    writeFileSync(
      path.join(dir, 'fly.builder.toml'),
      'app = "b"\nprimary_region = "iad"\n\n[env]\n  X = "1"\n\n[[vm]]\n  size = "performance-1x"\n  memory = "2048mb"\n',
    )
    writeFileSync(path.join(dir, 'fly.toml'), 'app = "s"\nprimary_region = "lax"\n')

    expect(() =>
      execFileSync(process.execPath, ['scripts/fly/builder-args.mjs'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/primary_region|region/i)
  })

  it('[TC-K2QW] Given a bash 3.2 host, when a caller builds the args array, then it uses a portable loop and aborts if the array is empty', () => {
    // Two coupled failure modes, both observed for real on macOS while
    // validating the right-size:
    //  1. `mapfile` is bash 4+, and macOS ships bash 3.2 as /bin/bash. There it
    //     fails with "command not found" and leaves the array EMPTY.
    //  2. An empty array means `fly machine run` falls back to Fly's bare
    //     defaults — shared-cpu-1x/256mb, no [env], placed near the caller
    //     rather than the pinned region — and still reports success. Two
    //     machines landed as shared-cpu-1x/256mb in `sjc` with serving in `iad`.
    for (const rel of ['scripts/fly/deploy.sh', 'scripts/fly/bootstrap.sh']) {
      const src = read(rel)
      // Comments may name mapfile (they explain why it is avoided); no
      // executable line may call it.
      const code = src.split('\n').filter((l) => !l.trim().startsWith('#'))
      expect(code.join('\n'), `${rel} must not call mapfile (bash 4+ only)`).not.toMatch(
        /^\s*mapfile\b/m,
      )
      expect(src, `${rel} must build the args with a portable read loop`).toMatch(
        /while IFS= read -r [^\n]*BUILDER_ARGS\+=/,
      )
      expect(src, `${rel} must abort on empty builder args`).toMatch(
        /\$\{#BUILDER_ARGS\[@\]\}\s*==\s*0/,
      )
    }
    const wf = read('.github/workflows/fly-deploy.yml')
    const wfCode = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(wfCode).not.toMatch(/^\s*mapfile\b/m)
    expect(wf).toMatch(/while IFS= read -r [^\n]*builder_args\+=/)
    expect(wf).toMatch(/\$\{#builder_args\[@\]\}"?\s*-eq\s*0/)
  })

  it('[TC-T41C] Given bootstrap.sh, when its step order is inspected, then the seed precedes the serving deploy and the roll token follows it', () => {
    const bootstrap = read('scripts/fly/bootstrap.sh')
    const seed = bootstrap.indexOf('cold-seeding every base')
    const serveDeploy = bootstrap.search(/fly deploy -a "\$SERVE_APP"/)
    const rollToken = bootstrap.indexOf('fly tokens create deploy')

    // Serving pins --bootstrap-policy snapshot-only, so it cannot boot before a
    // snapshot exists: seeding must come first.
    expect(seed).toBeGreaterThan(-1)
    expect(serveDeploy).toBeGreaterThan(seed)
    // roll-serving.mjs exits non-zero with no started serving machines, so
    // SERVE_APP/FLY_API_TOKEN must only land after serving is deployed.
    expect(rollToken).toBeGreaterThan(serveDeploy)
    const serveAppSecret = bootstrap.indexOf('SERVE_APP="$SERVE_APP" \\')
    expect(serveAppSecret).toBeGreaterThan(seed)
  })

  it('[TC-9XBD] Given teardown.sh, when run without flags, then it destroys the bucket too (its credentials cannot outlive the apps)', () => {
    const teardown = read('scripts/fly/teardown.sh')
    expect(teardown).toMatch(/fly storage destroy/)
    expect(teardown).toMatch(/KEEP_BUCKET=0/)
    // And it must warn that CI's app-scoped tokens are now dead.
    expect(teardown).toMatch(/FLY_API_TOKEN_KB_DEMO/)
  })

  it('[TC-3VPL] Given fly-lifecycle.yml, when inspected, then it is manual, confirmed, serialized, and delegates to the scripts', () => {
    const wf = read('.github/workflows/fly-lifecycle.yml')
    expect(wf).toMatch(/workflow_dispatch:/)
    expect(wf).toMatch(/- stand-up/)
    expect(wf).toMatch(/- tear-down/)
    // Teardown destroys every snapshot and the bucket keys are unrecoverable,
    // so a misfire costs a full cold rebuild: require an explicit phrase.
    expect(wf).toMatch(/inputs\.confirm \}\}" != "DESTROY"/)
    // Never overlap, never cancel mid-flight — a cancel inside teardown can
    // leave resources alive and still billing.
    expect(wf).toMatch(/group: fly-lifecycle/)
    expect(wf).toMatch(/cancel-in-progress: false/)
    // The ordering lives in the scripts, not duplicated into YAML.
    expect(wf).toMatch(/scripts\/fly\/bootstrap\.sh/)
    expect(wf).toMatch(/scripts\/fly\/teardown\.sh --yes/)
    // Creating/destroying apps is org-level; app-scoped deploy tokens cannot.
    expect(wf).toMatch(/FLY_API_TOKEN_ORG/)
    // A deploy token printed into a log is a live credential.
    expect(wf).not.toMatch(/echo "\$\(fly tokens create/)
  })

  it('[TC-7BQN] Given teardown.sh, when it finishes, then it verifies no billable resource survived', () => {
    const teardown = read('scripts/fly/teardown.sh')
    // A green teardown must mean a zero bill, so assert rather than assume.
    expect(teardown).toMatch(/verifying nothing is left billing/)
    expect(teardown).toMatch(/leftovers=\$\(\(leftovers \+ 1\)\)/)
    expect(teardown).toMatch(/exit 1/)
    // A remote `fly deploy` can leave a persistent builder app with a volume —
    // it survives destroying your own apps because it is not one of them.
    expect(teardown).toMatch(/fly-builder-/)
    expect(teardown).toMatch(/volumes list/)
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
