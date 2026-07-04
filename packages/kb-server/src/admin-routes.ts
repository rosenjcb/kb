/**
 * Admin + read REST routes — all kb operations except client-local config/skills/sync.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { KbService } from '@kb/core/service/kb-service.js'
import { readKbConfig } from '@kb/core/config/kb-config.js'
import { runServerCommand } from '@kb/core/cli/dispatch.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import { defaultLogsDir } from '@kb/core/core/telemetry.js'

export interface AdminRouteContext {
  service: KbService
  baseDir: string
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
  ctx: AdminRouteContext,
): Promise<boolean> {
  const { service, baseDir } = ctx

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
      sendJson(res, 400, { exitCode: 1, output: '', error: 'body.args must be a non-empty string array' })
      return true
    }
    const args = rawArgs.map(value => String(value))
    const config = await readKbConfig()
    const result = await runServerCommand(args, { config })
    sendJson(res, 200, result)
    return true
  }

  if (method === 'GET' && pathname === '/v1/bases') {
    sendJson(res, 200, { bases: [{ name: path.basename(baseDir), path: baseDir }] })
    return true
  }

  return false
}
