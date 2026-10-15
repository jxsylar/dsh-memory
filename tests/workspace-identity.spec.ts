import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownMemoryStore, MemoryValidationError } from '../src/memory-store.ts'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): MarkdownMemoryStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-identity-'))
  roots.push(root)
  return new MarkdownMemoryStore(new Context(), root)
}

function gitCommonDirFor(mapping: Record<string, string>): void {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    const cwd = args?.[1]
    if (typeof cwd !== 'string' || mapping[cwd] === undefined) throw new Error('not a Git repository')
    return `${mapping[cwd]}\n`
  })
}

describe('Workspace identity', () => {
  it('shares the main checkout memory and revision with worktrees at arbitrary locations', async () => {
    const main = '/projects/sample'
    const worktree = '/tmp/another-place/feature'
    const nested = '/tmp/another-place/feature/src'
    gitCommonDirFor({ [main]: `${main}/.git`, [worktree]: `${main}/.git`, [nested]: `${main}/.git` })
    const memory = store()
    const mainScope = memory.scopeForCwd(main)
    const worktreeScope = memory.scopeForCwd(worktree)
    const nestedScope = memory.scopeForCwd(nested)
    expect(execFileSync).toHaveBeenCalledWith('git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      expect.objectContaining({ encoding: 'utf8', timeout: 1000 }))
    expect(worktreeScope.key).toBe(mainScope.key)
    expect(worktreeScope.directory).toBe(mainScope.directory)
    expect(nestedScope.key).toBe(mainScope.key)
    expect(mainScope.cwd).toBe(resolve(main))
    expect(memory.workspaceReferenceForCwd(worktree)).toEqual(memory.workspaceReferenceForCwd(main))

    const empty = await memory.readWorkspace(mainScope)
    await memory.commitWorkspace({
      scope: mainScope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: 'project-rule', description: 'A project rule.', type: 'project', content: 'Shared by all checkouts.',
      } }],
    })
    const mainView = await memory.readWorkspace(mainScope)
    expect(await memory.readWorkspace(worktreeScope)).toEqual(mainView)
    expect(memory.renderContext(worktree)).toContain('project-rule')
    expect(memory.renderContextSnapshot(worktree).workspace).toEqual({ key: mainScope.key, revision: mainView.revision })
  })

  it('keeps separate repositories apart and preserves the existing main-root key', () => {
    gitCommonDirFor({
      '/projects/first': '/projects/first/.git',
      '/projects/second': '/projects/second/.git',
    })
    const memory = store()
    const first = memory.scopeForCwd('/projects/first')
    const second = memory.scopeForCwd('/projects/second')
    expect(first.key).not.toBe(second.key)
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('git unavailable') })
    expect(memory.scopeForCwd('/projects/first').key).toBe(first.key)
  })

  it('caches a Git identity per cwd and rechecks it after expiry', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    let commonDir = '/projects/first/.git'
    vi.mocked(execFileSync).mockImplementation(() => `${commonDir}\n`)
    const memory = store()
    const initial = memory.scopeForCwd('/tmp/feature')
    expect(memory.scopeForCwd('/tmp/feature').key).toBe(initial.key)
    expect(execFileSync).toHaveBeenCalledTimes(1)

    commonDir = '/projects/second/.git'
    clock.mockReturnValue(59_999)
    expect(memory.scopeForCwd('/tmp/feature').key).toBe(initial.key)
    clock.mockReturnValue(60_001)
    expect(memory.scopeForCwd('/tmp/feature').key).not.toBe(initial.key)
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })

  it('caches Git failures briefly and detects a repository that appears later', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('git unavailable') })
    const memory = store()
    const fallback = memory.scopeForCwd('/tmp/feature')
    vi.mocked(execFileSync).mockImplementation(() => '/projects/main/.git\n')
    expect(memory.scopeForCwd('/tmp/feature').key).toBe(fallback.key)
    expect(execFileSync).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(5_001)
    expect(memory.scopeForCwd('/tmp/feature').key).not.toBe(fallback.key)
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })

  it('bounds the number of cached cwd identities', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0)
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('git unavailable') })
    const memory = store()
    for (let index = 0; index <= 128; index++) memory.scopeForCwd(`/tmp/project-${index}`)
    memory.scopeForCwd('/tmp/project-0')
    expect(execFileSync).toHaveBeenCalledTimes(130)
  })

  it('uses the common directory for a nonstandard Git layout', () => {
    gitCommonDirFor({ '/projects/main': '/data/git/objects-for-project', '/tmp/feature': '/data/git/objects-for-project' })
    const memory = store()
    expect(memory.scopeForCwd('/projects/main').key).toBe(memory.scopeForCwd('/tmp/feature').key)
  })

  it('retains lexical identity for non-Git or nonexistent paths and rejects relative cwd', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('git unavailable') })
    const memory = store()
    expect(memory.scopeForCwd('/outside/one').key).not.toBe(memory.scopeForCwd('/outside/two').key)
    expect(memory.scopeForCwd('/outside/one/../one').key).toBe(memory.scopeForCwd('/outside/one').key)
    expect(() => memory.scopeForCwd('relative/path')).toThrow(MemoryValidationError)
  })
})
