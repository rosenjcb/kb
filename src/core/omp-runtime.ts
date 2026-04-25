import type { OmpCodingAgentModule, OmpModelRegistry } from './omp-agent-types.js'

let initializedCwd: string | undefined
let sharedAuthStorage: unknown
let sharedModelRegistry: OmpModelRegistry | undefined

/** Avoid static `import()` so `tsc` does not typecheck OMP’s shipped `.ts` graph under `node_modules`. */
async function loadOmp(): Promise<OmpCodingAgentModule> {
  // biome-ignore lint/security/noGlobalEval: runtime-only dynamic import string; static import pulls broken OMP sources into tsc
  // biome-ignore lint/style/noCommaOperator: `(0, eval)` forces indirect eval (global import) in Node
  const mod = await (0, eval)('import("@oh-my-pi/pi-coding-agent")')
  return mod as OmpCodingAgentModule
}

export async function ensureOmpRuntime(cwd: string): Promise<{
  authStorage: unknown
  modelRegistry: OmpModelRegistry
}> {
  if (initializedCwd !== cwd) {
    const omp = await loadOmp()
    const { Settings, discoverAuthStorage, ModelRegistry } = omp
    await Settings.init({ cwd })
    sharedAuthStorage = await discoverAuthStorage()
    sharedModelRegistry = new ModelRegistry(sharedAuthStorage)
    await sharedModelRegistry.refresh()
    initializedCwd = cwd
  }

  if (!sharedAuthStorage || !sharedModelRegistry) {
    throw new Error('OMP runtime failed to initialize')
  }

  return { authStorage: sharedAuthStorage, modelRegistry: sharedModelRegistry }
}

export async function createInMemoryOmpSession(options: {
  cwd: string
  model?: unknown
  toolNames?: string[]
  customTools?: unknown[]
  systemPrompt?: string | ((defaultPrompt: string) => string)
  enableMCP?: boolean
  enableLsp?: boolean
}) {
  const omp = await loadOmp()
  const { createAgentSession, SessionManager } = omp
  const { authStorage, modelRegistry } = await ensureOmpRuntime(options.cwd)
  return createAgentSession({
    cwd: options.cwd,
    authStorage,
    modelRegistry,
    model: options.model,
    toolNames: options.toolNames,
    customTools: options.customTools,
    systemPrompt: options.systemPrompt,
    enableMCP: options.enableMCP ?? false,
    enableLsp: options.enableLsp ?? false,
    sessionManager: SessionManager.inMemory(options.cwd),
  })
}
