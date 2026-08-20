import { existsSync, readFileSync, readdirSync } from 'node:fs'
/**
 * Admin + read REST routes — all kb operations except client-local config/skills/sync.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { runServerCommand } from '@kb/core/cli/dispatch.js'
import { readKbConfig } from '@kb/core/config/kb-config.js'
import { defaultLogsDir } from '@kb/core/core/telemetry.js'
import { gitRemoteToBrowseUrl } from '@kb/core/ops/git-sync.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import type { KbService } from '@kb/core/service/kb-service.js'
import { resolveBaseRepoRegistry } from '@kb/core/storage/base-repos.js'
import type { KbServiceRegistry } from './service-registry.js'

/** One source repo advertised for a base, ready for client-side blob links. */
interface BaseRepoSummary {
  slug: string
  /** HTTPS browse root (no trailing slash), or null when it can't be derived. */
  url: string | null
  branch: string
}

/**
 * Source repos for a base, for the chat demo's base picker. Uses the same
 * `resolveBaseRepoRegistry` that citations use, so this route can never advertise
 * a repo the citation path cannot link.
 */
async function baseReposFor(basePath: string): Promise<BaseRepoSummary[]> {
  try {
    const repos = await resolveBaseRepoRegistry(basePath)
    return repos.map(repo => ({
      slug: repo.slug,
      url: gitRemoteToBrowseUrl(repo.gitUrl),
      branch: repo.gitBranch,
    }))
  } catch {
    return []
  }
}

export interface AdminRouteContext {
  service: KbService
  baseDir: string
  /** Multi-base registry, when the server serves more than its boot base. */
  registry?: KbServiceRegistry
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function handleAdminRoute(
  method: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminRouteContext
): Promise<boolean> {
  const { service, baseDir, registry } = ctx

  if (method === 'POST' && pathname === '/v1/facts/search') {
    const body = await readJsonBody(req)
    const result = await service.readFacts(body)
    sendJson(res, 200, result)
    return true
  }

  if (method === 'GET' && pathname === '/v1/docs') {
    const result = await service.readFacts({ intent: 'list_documents', limit: 200 })
    sendJson(res, 200, result)
    return true
  }

  const docMatch = pathname.match(/^\/v1\/docs\/([^/]+)$/)
  if (method === 'GET' && docMatch) {
    const id = decodeURIComponent(docMatch[1])
    const result = await service.readFacts({ intent: 'read_document', id })
    sendJson(res, 200, result)
    return true
  }

  if (method === 'GET' && pathname === '/v1/graph/summary') {
    const result = await service.toolExecutor.execute({
      id: 'admin',
      name: 'get_code_graph_summary',
      input: {},
    })
    sendJson(res, 200, result)
    return true
  }

  if (method === 'GET' && pathname === '/v1/logs') {
    const logsDir = defaultLogsDir()
    const files = existsSync(logsDir)
      ? readdirSync(logsDir)
          .filter(name => name.endsWith('.jsonl'))
          .sort()
          .reverse()
          .slice(0, 14)
      : []
    sendJson(res, 200, { logsDir, files })
    return true
  }

  const logMatch = pathname.match(/^\/v1\/logs\/([^/]+)$/)
  if (method === 'GET' && logMatch) {
    const name = decodeURIComponent(logMatch[1])
    if (!/^[\w-]+\.jsonl$/.test(name)) {
      sendJson(res, 400, { error: 'invalid log file name' })
      return true
    }
    const filePath = path.join(defaultLogsDir(), name)
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: 'log file not found' })
      return true
    }
    const content = readFileSync(filePath, 'utf8')
    sendJson(res, 200, { file: name, content })
    return true
  }

  if (method === 'POST' && pathname === '/v1/admin/scan') {
    const summary = await runScanCommand(['--base', path.basename(baseDir)])
    sendJson(res, 200, { status: 'ok', summary })
    return true
  }

  if (method === 'POST' && pathname === '/v1/admin/cli') {
    await service.waitForBootstrap()
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, {
        exitCode: 1,
        output: '',
        error: error instanceof Error ? error.message : 'invalid JSON body',
      })
      return true
    }
    const rawArgs = body.args
    if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
      sendJson(res, 400, {
        exitCode: 1,
        output: '',
        error: 'body.args must be a non-empty string array',
      })
      return true
    }
    const args = rawArgs.map(value => String(value))
    const config = await readKbConfig()
    // Scope the command to the base this request selected (`X-KB-Base`), the same way
    // /v1/admin/scan does. The client strips `--base` from argv and sends it as that
    // header, so without this every admin command would run against the server's
    // default base no matter which base the caller asked for.
    const result = await runServerCommand(args, {
      config,
      baseName: path.basename(baseDir),
    })
    sendJson(res, 200, result)
    return true
  }

  if (method === 'GET' && pathname === '/v1/bases') {
    if (registry) {
      const bases = await registry.list()
      const withRepos = await Promise.all(
        bases.map(async base => ({
          name: base.name,
          path: base.path,
          default: base.default,
          repos: await baseReposFor(base.path),
        }))
      )
      sendJson(res, 200, {
        default: registry.defaultBaseName,
        bases: withRepos,
      })
      return true
    }
    // Single-base server: advertise just the boot base.
    sendJson(res, 200, {
      default: path.basename(baseDir),
      bases: [
        {
          name: path.basename(baseDir),
          path: baseDir,
          default: true,
          repos: await baseReposFor(baseDir),
        },
      ],
    })
    return true
  }

  return false
}
