/**
 * Base-keyed registry of `KbService` instances.
 *
 * A kb-server process serves one **default** base (resolved + bootstrapped at
 * boot) but can also serve any other already-built base on the same host,
 * selected per request via the `X-KB-Base` header (or a body `base`). This turns
 * one long-running server into a psql-style postmaster: one process, many bases
 * addressed by slug — so callers (notably `kb eval`) no longer need a separate
 * server process per base.
 *
 * The default base keeps its bootstrap/indexing lifecycle. Non-default bases are
 * **serve-only**: created lazily on first touch, and only when their
 * `.kb-index.sqlite` already exists on disk. An unknown base is a
 * `BaseNotFoundError` (surfaced as HTTP 404) — base creation stays a separate
 * `kb init` / scan concern, exactly as `CREATE DATABASE` is separate from
 * connecting in Postgres.
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { createKbService, type KbService } from '@kb/core/service/kb-service.js'
import type { ChatStreamFn } from '@kb/core/service/chat-types.js'
import { listAllBases, resolveBaseToDir } from '@kb/core/storage/base-selection.js'
import { kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'

/** Thrown when a requested base slug has no built index on this host. */
export class BaseNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(
      `unknown base "${slug}": no index found on this server. Create it with ` +
        `\`kb-server base create ${slug} --git <url>\`, or omit the base to use the server default.`
    )
    this.name = 'BaseNotFoundError'
  }
}

export interface BaseSummary {
  name: string
  path: string
  /** True for the process's boot/default base. */
  default: boolean
}

export interface KbServiceRegistry {
  /** The boot/default base name (what an omitted `X-KB-Base` resolves to). */
  readonly defaultBaseName: string
  /** Resolve the service for a base slug; empty/undefined ⇒ default. Throws BaseNotFoundError. */
  resolve(slug?: string): KbService
  /** List bases this server can serve (default + any built base under ~/.kb/sessions). */
  list(): Promise<BaseSummary[]>
  /** Close every lazily-created service (the default is owned by the caller). */
  closeAll(): Promise<void>
}

export interface RegistryOptions {
  /** The boot service (already created with its bootstrap state). */
  defaultService: KbService
  config: KbConfig
  chatStream?: ChatStreamFn
}

export function createKbServiceRegistry(options: RegistryOptions): KbServiceRegistry {
  const { defaultService, config, chatStream } = options
  const defaultBaseDir = defaultService.baseDir
  const defaultBaseName = path.basename(defaultBaseDir)

  // Keyed by resolved absolute base dir so aliases and path-like refs collapse.
  const lazyServices = new Map<string, KbService>()

  function resolveBaseDir(slug: string): string {
    try {
      return resolveBaseToDir(slug)
    } catch {
      throw new BaseNotFoundError(slug)
    }
  }

  return {
    defaultBaseName,

    resolve(slug) {
      const trimmed = slug?.trim()
      if (!trimmed) return defaultService

      const baseDir = resolveBaseDir(trimmed)
      if (baseDir === defaultBaseDir) return defaultService

      const cached = lazyServices.get(baseDir)
      if (cached) return cached

      // Serve-only: never build on connect. Missing index ⇒ 404.
      if (!existsSync(kbIndexDbPath(baseDir))) {
        throw new BaseNotFoundError(trimmed)
      }

      // createKbService is synchronous, so there is no await gap to race on.
      const service = createKbService({ baseDir, config, chatStream })
      lazyServices.set(baseDir, service)
      return service
    },

    async list() {
      const built = await listAllBases()
      const summaries: BaseSummary[] = built.map(base => ({
        name: base.name,
        path: base.path,
        default: base.path === defaultBaseDir,
      }))
      // The default base may live outside ~/.kb/sessions (path-like ref); ensure
      // it is always advertised.
      if (!summaries.some(base => base.default)) {
        summaries.unshift({ name: defaultBaseName, path: defaultBaseDir, default: true })
      }
      return summaries
    },

    async closeAll() {
      await Promise.all([...lazyServices.values()].map(service => service.close()))
      lazyServices.clear()
    },
  }
}
