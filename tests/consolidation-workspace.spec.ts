import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONSOLIDATION_WORKSPACE_TITLE,
  DedicatedConsolidationWorkspace,
  isConsolidationWorkspaceCwd,
} from '../src/consolidation-workspace.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DedicatedConsolidationWorkspace', () => {
  it('creates a private cwd and attaches Sessions through the native Workspace registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-consolidation-workspace-'))
    roots.push(root)
    const directory = join(root, 'runtime', 'consolidator')
    const calls: unknown[] = []
    const placement = new DedicatedConsolidationWorkspace(directory, () => ({
      async create(path, title) {
        calls.push({ path, title })
        return {
          path,
          async attachSession(sessionId) { calls.push({ sessionId }) },
        }
      },
    }))

    const prepared = await placement.prepare()
    await prepared.attachSession(SessionId('session-worker'))

    expect(prepared.cwd).toBe(realpathSync(directory))
    expect(calls).toEqual([
      { path: realpathSync(directory), title: CONSOLIDATION_WORKSPACE_TITLE },
      { sessionId: 'session-worker' },
    ])
  })

  it('still isolates the physical cwd when the Workspace registry is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-consolidation-workspace-'))
    roots.push(root)
    const directory = join(root, 'consolidator')
    const prepared = await new DedicatedConsolidationWorkspace(directory).prepare()
    await expect(prepared.attachSession(SessionId('session-worker'))).resolves.toBeUndefined()
    expect(prepared.cwd).toBe(realpathSync(directory))
  })

  it('rejects a registry Workspace that resolves to another directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-consolidation-workspace-'))
    roots.push(root)
    await expect(new DedicatedConsolidationWorkspace(join(root, 'consolidator'), () => ({
      async create() {
        return { path: '/unexpected', async attachSession() {} }
      },
    })).prepare()).rejects.toThrow(/unexpected path/)
  })

  it('matches only the dedicated operational cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-consolidation-workspace-'))
    roots.push(root)
    const directory = join(root, 'consolidator')
    expect(isConsolidationWorkspaceCwd(directory, directory)).toBe(true)
    expect(isConsolidationWorkspaceCwd(join(root, 'project'), directory)).toBe(false)
    expect(isConsolidationWorkspaceCwd('relative/consolidator', directory)).toBe(false)
    expect(isConsolidationWorkspaceCwd(undefined, directory)).toBe(false)
  })
})
