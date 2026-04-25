/**
 * Narrow surface used from `@oh-my-pi/pi-coding-agent` (package has no usable public types).
 */

export interface OmpModelRegistry {
  refresh: () => Promise<void>
  find: (provider: string, model: string) => unknown
}

export interface OmpInMemoryAgentSession {
  prompt: (text: string, opts: { attribution: string }) => Promise<void>
  waitForIdle: () => Promise<void>
  getLastAssistantMessage: () => { content?: unknown } | undefined
  getMessages?: () => Array<{ role?: string; content?: unknown }>
  subscribe: (cb: (event: unknown) => void) => () => void
  dispose: () => Promise<void>
}

export interface OmpCreateSessionResult {
  session: OmpInMemoryAgentSession
}

export interface OmpCodingAgentModule {
  Settings: { init: (opts: { cwd: string }) => Promise<void> }
  discoverAuthStorage: () => Promise<unknown>
  ModelRegistry: new (auth: unknown) => OmpModelRegistry
  createAgentSession: (opts: Record<string, unknown>) => Promise<OmpCreateSessionResult>
  SessionManager: { inMemory: (cwd: string) => unknown }
}
