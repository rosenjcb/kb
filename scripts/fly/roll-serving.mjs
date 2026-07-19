#!/usr/bin/env node
// Health-gated rolling restart of the serving app's machines.
//
// The serving node is stateless: restarting it re-runs serve-entrypoint.sh,
// which wipes KB_HOME, downloads the snapshot latest.json now points at, and
// warm-starts frozen. So "swap the little node onto the new volume" == restart
// the serving machine(s) after the pointer flip.
//
// To keep downtime "as little as possible" we restart machines ONE AT A TIME
// and wait for /healthz ok:true before touching the next:
//   * 1 serving machine  → a few seconds of gap (snapshot-only boot just
//     downloads + opens SQLite; no index build).
//   * 2+ serving machines → true zero-downtime rolling swap.
//
// Uses the Fly Machines API directly (just HTTPS + a token) so the builder
// needs no flyctl. Requires:
//   FLY_API_TOKEN     deploy token scoped to the serving app (`fly tokens create deploy -a <app>`)
//   SERVE_APP         serving app name (e.g. kb-demo)
//   SERVE_HEALTH_URL  public health URL (default https://<SERVE_APP>.fly.dev/healthz)

const API = process.env.FLY_API_HOSTNAME || 'https://api.machines.dev'
const healthTimeoutMs = Number(process.env.ROLL_HEALTH_TIMEOUT_MS || 120_000)
const settleMs = Number(process.env.ROLL_SETTLE_MS || 3_000)

function req(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`error: ${name} is required for the serving roll.`)
    process.exit(1)
  }
  return v
}

const token = req('FLY_API_TOKEN')
const app = req('SERVE_APP')
const healthUrl = process.env.SERVE_HEALTH_URL || `https://${app}.fly.dev/healthz`

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Fly API ${init.method || 'GET'} ${path} → ${res.status} ${body}`)
  }
  return res.status === 204 ? null : res.json()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Poll the public /healthz until the body reports ok:true (readiness lives in
// the body; the endpoint itself is always 200 when reachable).
async function waitHealthy(label) {
  const deadline = Date.now() + healthTimeoutMs
  for (;;) {
    try {
      const res = await fetch(healthUrl, { cache: 'no-store' })
      const body = await res.json()
      if (body && body.ok === true) return
      process.stdout.write(`    ${label}: waiting (ok=${body?.ok} indexing=${body?.indexing ?? false})\n`)
    } catch (err) {
      process.stdout.write(`    ${label}: waiting (${err.message})\n`)
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: /healthz did not report ok:true within ${healthTimeoutMs}ms`)
    }
    await sleep(2_000)
  }
}

async function main() {
  const machines = await api(`/v1/apps/${app}/machines`)
  const group = process.env.SERVE_PROCESS_GROUP || 'app'
  // Only the serving process group, only currently-started machines.
  const serving = machines.filter(
    m => m.state === 'started' && (m.config?.metadata?.fly_process_group ?? 'app') === group
  )
  if (serving.length === 0) {
    console.error(`error: no started serving machines found for app '${app}'.`)
    process.exit(1)
  }
  console.log(`  · rolling ${serving.length} serving machine(s) one at a time`)

  for (const m of serving) {
    console.log(`    - restart ${m.id} (${m.region})`)
    // Restart re-runs the entrypoint → re-download + re-adopt the new snapshot.
    await api(`/v1/apps/${app}/machines/${m.id}/restart`, { method: 'POST' })
    // Let the machine begin its reboot before we start polling shared health.
    await sleep(settleMs)
    await waitHealthy(m.id)
    console.log(`      ${m.id} healthy on the new snapshot`)
  }
  console.log('  · rolling restart complete — serving the fresh snapshot')
}

main().catch(err => {
  console.error(`error: serving roll failed: ${err.message}`)
  process.exit(1)
})
