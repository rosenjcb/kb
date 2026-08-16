import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  listTaskIds,
  loadTaskYaml,
  buildTaskPrompt,
  buildKbArmArgv,
  buildControlArmArgv,
  inspectArmOutcome,
  buildArtifact,
  cloneAtCommit,
  branchOffCommit,
  TASK_ARTIFACT_SCHEMA_VERSION,
  DEFAULT_MAX_TURNS,
} from '../scripts/eval-task.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-task-test-'))
}

/** Bare local git repo + one commit, so cloneAtCommit/inspectArmOutcome can run against it
 * without network access. */
function makeLocalRepo() {
  const dir = tmpDir()
  const run = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout
  }
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  run('add', 'a.txt')
  run('commit', '-q', '-m', 'initial')
  const commit = run('rev-parse', 'HEAD').trim()
  return { dir, commit }
}

describe('eval/tasks/*.yaml loading', () => {
  it('[TC-260] lists the kestra-18144 example task', () => {
    expect(listTaskIds()).toContain('kestra-18144')
  })

  it('[TC-261] loadTaskYaml reads the required fields from a real task file', () => {
    const task = loadTaskYaml('kestra-18144')
    expect(task.id).toBe('kestra-18144')
    expect(task.repo_url).toContain('kestra')
    expect(task.kb_base).toBe('eval-kestra')
    expect(task.issue).toEqual({ repo: 'kestra-io/kestra', number: 18144 })
  })

  it('[TC-262] loadTaskYaml throws a clear error for an unknown task id', () => {
    expect(() => loadTaskYaml('does-not-exist')).toThrow(/no task file/)
  })

  it('[TC-263] loadTaskYaml accepts a direct path to a YAML file', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'custom.yaml')
    fs.writeFileSync(
      file,
      'id: custom\nrepo_url: https://example.com/x.git\nkb_base: eval-x\nprompt: "do the thing"\n'
    )
    const task = loadTaskYaml(file)
    expect(task.id).toBe('custom')
    expect(task.prompt).toBe('do the thing')
  })

  it('[TC-264] loadTaskYaml requires one of issue or prompt', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'bad.yaml')
    fs.writeFileSync(file, 'id: bad\nrepo_url: https://example.com/x.git\nkb_base: eval-x\n')
    expect(() => loadTaskYaml(file)).toThrow(/issue.*prompt|prompt.*issue/i)
  })
})

describe('buildTaskPrompt', () => {
  it('[TC-265] returns the literal prompt field trimmed, without touching gh, when prompt is set', () => {
    const prompt = buildTaskPrompt({ prompt: '  fix the thing  ' })
    expect(prompt).toBe('fix the thing')
  })
})

describe('agent argv construction', () => {
  const server = { host: '127.0.0.1', port: 38117, base: 'eval-kestra' }

  it('[TC-266] kb arm argv is headless JSON output with the base forced into --mcp-config headers', () => {
    const argv = buildKbArmArgv({ maxTurns: 30, server })
    expect(argv).toContain('-p')
    expect(argv).toContain('--output-format')
    expect(argv).toContain('json')
    expect(argv).toContain('--max-turns')
    expect(argv).toContain('30')
    const mcpIdx = argv.indexOf('--mcp-config')
    expect(mcpIdx).toBeGreaterThan(-1)
    const mcpConfig = JSON.parse(argv[mcpIdx + 1])
    expect(mcpConfig.mcpServers.kb.headers['X-KB-Base']).toBe('eval-kestra')
    expect(mcpConfig.mcpServers.kb.url).toBe('http://127.0.0.1:38117/mcp')
  })

  it('[TC-267] kb arm argv includes an Authorization header only when an apiKey is given', () => {
    const withKey = buildKbArmArgv({ maxTurns: 30, server: { ...server, apiKey: 'secret' } })
    const withoutKey = buildKbArmArgv({ maxTurns: 30, server })
    const cfgWith = JSON.parse(withKey[withKey.indexOf('--mcp-config') + 1])
    const cfgWithout = JSON.parse(withoutKey[withoutKey.indexOf('--mcp-config') + 1])
    expect(cfgWith.mcpServers.kb.headers.Authorization).toBe('Bearer secret')
    expect(cfgWithout.mcpServers.kb.headers.Authorization).toBeUndefined()
  })

  it('[TC-268] kb arm argv inlines the kb:dev-workflow skill body into --append-system-prompt', () => {
    const argv = buildKbArmArgv({ maxTurns: 30, server })
    const appendIdx = argv.indexOf('--append-system-prompt')
    expect(argv[appendIdx + 1]).toContain('kb MCP')
    expect(argv[appendIdx + 1]).toContain("base: 'eval-kestra'")
  })

  it("[TC-269] control arm argv blocks kb's MCP tools, Skill, and kb Bash commands", () => {
    const argv = buildControlArmArgv({ maxTurns: 30 })
    const idx = argv.indexOf('--disallowedTools')
    expect(argv[idx + 1]).toContain('mcp__kb__query')
    expect(argv[idx + 1]).toContain('Skill')
    expect(argv[idx + 1]).toContain('Bash(kb:*)')
  })

  it('[TC-270] control arm argv strips MCP entirely via --strict-mcp-config + empty mcpServers', () => {
    const argv = buildControlArmArgv({ maxTurns: 30 })
    expect(argv).toContain('--strict-mcp-config')
    const mcpIdx = argv.indexOf('--mcp-config')
    expect(JSON.parse(argv[mcpIdx + 1])).toEqual({ mcpServers: {} })
  })

  it('[TC-271] both arms omit --max-turns when maxTurns is falsy', () => {
    const kb = buildKbArmArgv({ maxTurns: null, server })
    const control = buildControlArmArgv({ maxTurns: 0 })
    expect(kb).not.toContain('--max-turns')
    expect(control).not.toContain('--max-turns')
  })

  it('[TC-272] DEFAULT_MAX_TURNS matches control-core.mjs’s control default (30)', () => {
    expect(DEFAULT_MAX_TURNS).toBe(30)
  })
})

describe('cloneAtCommit + branchOffCommit + inspectArmOutcome (local repo, no network)', () => {
  it('[TC-273] clones a local repo and checks out the given commit, returning that sha', () => {
    const { dir: source, commit } = makeLocalRepo()
    const dest = path.join(tmpDir(), 'clone')
    const resolved = cloneAtCommit({ url: source, dest, commit })
    expect(resolved).toBe(commit)
    expect(fs.existsSync(path.join(dest, 'a.txt'))).toBe(true)
  })

  it('[TC-274] with no commit given, resolves to the cloned default-branch tip', () => {
    const { dir: source, commit } = makeLocalRepo()
    const dest = path.join(tmpDir(), 'clone2')
    const resolved = cloneAtCommit({ url: source, dest, commit: null })
    expect(resolved).toBe(commit)
  })

  it('[TC-275] inspectArmOutcome reports committed:false and the uncommitted diff when nothing was committed', () => {
    const { dir: source, commit } = makeLocalRepo()
    const dest = path.join(tmpDir(), 'clone3')
    cloneAtCommit({ url: source, dest, commit })
    branchOffCommit(dest, 'eval-task/test-branch')
    fs.appendFileSync(path.join(dest, 'a.txt'), 'two\n')
    const outcome = inspectArmOutcome(dest, commit)
    expect(outcome.committed).toBe(false)
    expect(outcome.head_commit).toBe(commit)
    expect(outcome.committed_diff_stat).toBeNull()
    expect(outcome.uncommitted_diff_stat).toContain('a.txt')
  })

  it('[TC-276] inspectArmOutcome reports committed:true and a committed diff stat after a real commit', () => {
    const { dir: source, commit } = makeLocalRepo()
    const dest = path.join(tmpDir(), 'clone4')
    cloneAtCommit({ url: source, dest, commit })
    branchOffCommit(dest, 'eval-task/test-branch')
    fs.writeFileSync(path.join(dest, 'b.txt'), 'new file\n')
    spawnSync('git', ['add', 'b.txt'], { cwd: dest })
    spawnSync('git', ['commit', '-q', '-m', 'add b.txt'], { cwd: dest })
    const outcome = inspectArmOutcome(dest, commit)
    expect(outcome.committed).toBe(true)
    expect(outcome.head_commit).not.toBe(commit)
    expect(outcome.committed_diff_stat).toContain('b.txt')
    expect(outcome.uncommitted_diff_stat).toBeNull()
  })
})

describe('buildArtifact', () => {
  const task = { id: 't', repo_url: 'https://example.com/x.git', commit: 'abc', kb_base: 'eval-x', issue: null }
  const telemetry = (turns, cost, dur, out) => ({
    input_tokens: 0,
    output_tokens: out,
    cache_read_tokens: 0,
    total_cost_usd: cost,
    num_turns: turns,
    duration_ms: dur,
    session_id: 's',
    is_error: false,
  })

  it('[TC-277] schema_version and evaluation_plan point at TASK_EVALUATION.md', () => {
    const artifact = buildArtifact({ runName: 'r', task, maxTurns: 30, prompt: 'p', kbOutcome: null, controlOutcome: null })
    expect(artifact.schema_version).toBe(TASK_ARTIFACT_SCHEMA_VERSION)
    expect(artifact.evaluation_plan).toBe('TASK_EVALUATION.md')
  })

  it('[TC-278] status is partial when only one arm ran, complete when at least one did', () => {
    const none = buildArtifact({ runName: 'r', task, maxTurns: 30, prompt: 'p', kbOutcome: null, controlOutcome: null })
    expect(none.status).toBe('partial')
    const kbOnly = buildArtifact({
      runName: 'r',
      task,
      maxTurns: 30,
      prompt: 'p',
      kbOutcome: { committed: true, head_commit: 'x', committed_diff_stat: 's', uncommitted_diff_stat: null, telemetry: telemetry(5, 1, 100, 10), wall_ms: 100 },
      controlOutcome: null,
    })
    expect(kbOnly.status).toBe('complete')
    expect(kbOnly.arms.control).toBeNull()
  })

  it('[TC-279] comparison is null unless both arms ran, and only computed when both did', () => {
    const kbOutcome = { committed: true, head_commit: 'x', committed_diff_stat: 's', uncommitted_diff_stat: null, telemetry: telemetry(10, 1.25, 1000, 100), wall_ms: 1000 }
    const controlOutcome = { committed: false, head_commit: 'abc', committed_diff_stat: null, uncommitted_diff_stat: 's2', telemetry: telemetry(20, 2.0, 2000, 200), wall_ms: 2000 }
    const onlyKb = buildArtifact({ runName: 'r', task, maxTurns: 30, prompt: 'p', kbOutcome, controlOutcome: null })
    expect(onlyKb.comparison).toBeNull()
    const both = buildArtifact({ runName: 'r', task, maxTurns: 30, prompt: 'p', kbOutcome, controlOutcome })
    expect(both.comparison.committed).toEqual({ kb: true, control: false })
    expect(both.comparison.num_turns).toEqual({ kb: 10, control: 20, delta_kb_minus_control: -10 })
    expect(both.comparison.total_cost_usd.delta_kb_minus_control).toBeCloseTo(-0.75, 5)
  })

  it('[TC-280] the task block carries the resolved prompt, not just the task id', () => {
    const artifact = buildArtifact({ runName: 'r', task, maxTurns: 30, prompt: 'the resolved verbatim prompt', kbOutcome: null, controlOutcome: null })
    expect(artifact.task.prompt).toBe('the resolved verbatim prompt')
    expect(artifact.task.max_turns).toBe(30)
  })
})
