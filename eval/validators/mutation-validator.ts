import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { Parser, Language } from 'web-tree-sitter'
import type { Node as TsNode } from 'web-tree-sitter'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

export interface MutationResult {
  baselinePassed: boolean
  mutantFailed: boolean
  valid: boolean
  timedOut: boolean
  perSymbol: Record<string, boolean>
  errors: string[]
}

const MOEL_STUB = '{ throw new Error("moel-stub"); }'

let sharedParser: Parser | null = null

async function ensureParser(): Promise<Parser> {
  if (sharedParser) return sharedParser
  await Parser.init()
  sharedParser = new Parser()
  return sharedParser
}

function resolveWasmPath(ext: string): string {
  if (ext === '.tsx') {
    return require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm') as string
  }
  return require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm') as string
}

/** Walk tree to find the body (statement_block) of a named function or method. */
function findBody(node: TsNode, symbolName: string): TsNode | null {
  if (
    (node.type === 'function_declaration' || node.type === 'method_definition') &&
    node.childForFieldName('name')?.text === symbolName
  ) {
    return node.childForFieldName('body') ?? null
  }
  // Also handle export_statement wrapping function_declaration
  if (node.type === 'export_statement') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      if (
        child.type === 'function_declaration' &&
        child.childForFieldName('name')?.text === symbolName
      ) {
        return child.childForFieldName('body') ?? null
      }
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    const result = findBody(child, symbolName)
    if (result) return result
  }
  return null
}

/** Apply mutation stub to a file, returning the patched content. */
async function patchFile(filePath: string, symbolName: string): Promise<string | null> {
  const src = await readFile(filePath, 'utf8')
  const ext = path.extname(filePath)
  const wasmPath = resolveWasmPath(ext)

  const parser = await ensureParser()
  const language = await Language.load(wasmPath)
  parser.setLanguage(language)

  const tree = parser.parse(src)
  const bodyNode = findBody(tree.rootNode, symbolName)

  if (!bodyNode) return null

  const patched = src.slice(0, bodyNode.startIndex) + MOEL_STUB + src.slice(bodyNode.endIndex)
  return patched
}

/** Find TypeScript source files containing a symbol by name. */
async function findFilesForSymbol(repoPath: string, symbolName: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['grep', '-l', symbolName],
      { cwd: repoPath, encoding: 'utf8' }
    )
    return stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.endsWith('.ts') || l.endsWith('.tsx'))
      .map(l => path.join(repoPath, l))
  } catch {
    return []
  }
}

async function runTests(
  cwd: string,
  timeoutMs: number
): Promise<{ passed: boolean; timedOut: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', 'test'], {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env },
      encoding: 'utf8',
    })
    return { passed: true, timedOut: false, output: stdout + stderr }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string }
    const timedOut = error.killed === true || error.code === 'ETIMEDOUT'
    return {
      passed: false,
      timedOut,
      output: (error.stdout ?? '') + (error.stderr ?? ''),
    }
  }
}

async function createWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', '--detach', worktreePath], {
    encoding: 'utf8',
  })
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], {
      encoding: 'utf8',
    })
  } catch {
    // Best-effort cleanup
  }
  try {
    await rm(worktreePath, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup
  }
}

export class MutationValidator {
  /**
   * Run baseline and mutation tests for the given target symbols.
   *
   * 1. Run npm test in repoPath (baseline — must pass).
   * 2. For each symbol, create a git worktree, patch the function body, run tests.
   * 3. Tests must fail in the worktree (mutant killed = valid).
   */
  async run(
    repoPath: string,
    targetSymbols: string[],
    testTimeout = 60_000
  ): Promise<MutationResult> {
    const errors: string[] = []
    const perSymbol: Record<string, boolean> = {}

    // Baseline run
    const baseline = await runTests(repoPath, testTimeout)
    if (!baseline.passed) {
      return {
        baselinePassed: false,
        mutantFailed: false,
        valid: false,
        timedOut: baseline.timedOut,
        perSymbol: {},
        errors: ['Baseline test suite failed — cannot perform mutation check'],
      }
    }

    // Per-symbol mutation runs
    for (const symbolName of targetSymbols) {
      const tmpParent = await mkdtemp(path.join(os.tmpdir(), 'moel-mutation-'))
      const worktreePath = path.join(tmpParent, 'worktree')

      try {
        await createWorktree(repoPath, worktreePath)

        // Find and patch the symbol
        const candidateFiles = await findFilesForSymbol(worktreePath, symbolName)
        let patched = false

        for (const filePath of candidateFiles) {
          const patchedContent = await patchFile(filePath, symbolName)
          if (patchedContent !== null) {
            await writeFile(filePath, patchedContent, 'utf8')
            patched = true
            break
          }
        }

        if (!patched) {
          errors.push(`Symbol '${symbolName}' not found or has no statement_block body`)
          perSymbol[symbolName] = false
          continue
        }

        const mutant = await runTests(worktreePath, testTimeout)
        if (mutant.timedOut) {
          errors.push(`Mutant test run for '${symbolName}' timed out`)
          perSymbol[symbolName] = false
        } else {
          // Mutant killed = tests fail when body is stubbed = good
          perSymbol[symbolName] = !mutant.passed
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`Error processing symbol '${symbolName}': ${msg}`)
        perSymbol[symbolName] = false
      } finally {
        await removeWorktree(repoPath, worktreePath)
        await rm(tmpParent, { recursive: true, force: true }).catch(() => {})
      }
    }

    const allMutantsKilled = Object.values(perSymbol).length > 0 &&
      Object.values(perSymbol).every(v => v)

    return {
      baselinePassed: true,
      mutantFailed: allMutantsKilled,
      valid: allMutantsKilled,
      timedOut: false,
      perSymbol,
      errors,
    }
  }
}
