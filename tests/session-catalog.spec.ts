import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemorySessionSnapshot } from '../src/host-contracts.ts'
import { MarkdownMemoryStore } from '../src/memory-store.ts'
import { SessionCatalog } from '../src/session-catalog.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): MarkdownMemoryStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-session-catalog-'))
  roots.push(root)
  const value = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  value.initialize()
  return value
}

function snapshot(id: string, revision: string, createdAt: number, cwd?: string): MemorySessionSnapshot {
  return cwd === undefined
    ? { header: { id, createdAt }, revision }
    : { header: { id, createdAt, cwd }, revision }
}

describe('Session candidate catalog', () => {
  it('uses two backend-neutral snapshot reads and excludes live, cwd-less, and unstable Sessions', async () => {
    const first = [
      snapshot('eligible', 'source:a', 50, '/work/project-alpha'),
      snapshot('live', 'source:b', 40, '/work/project-beta'),
      snapshot('missing-cwd', 'source:c', 30),
      snapshot('changed', 'source:d1', 20, '/work/project-delta'),
      snapshot('relative', 'source:e', 10, 'relative/project'),
    ]
    const second = [
      snapshot('eligible', 'source:a', 50, '/work/project-alpha'),
      snapshot('live', 'source:b', 40, '/work/project-beta'),
      snapshot('missing-cwd', 'source:c', 30),
      snapshot('changed', 'source:d2', 20, '/work/project-delta'),
      snapshot('relative', 'source:e', 10, 'relative/project'),
    ]
    let calls = 0
    const catalog = new SessionCatalog(store(), {
      async listSnapshots() {
        calls += 1
        return calls === 1 ? first : second
      },
    }, {
      get(id) { return id === 'live' ? {} : undefined },
    })

    await expect(catalog.list()).resolves.toEqual({
      available: true,
      sessions: [
        { sessionId: 'eligible', createdAt: 50, workspaceName: 'project-alpha', eligible: true, reason: null, latestReceipt: null },
        { sessionId: 'live', createdAt: 40, workspaceName: 'project-beta', eligible: false, reason: 'live', latestReceipt: null },
        { sessionId: 'missing-cwd', createdAt: 30, workspaceName: null, eligible: false, reason: 'missing-cwd', latestReceipt: null },
        { sessionId: 'changed', createdAt: 20, workspaceName: 'project-delta', eligible: false, reason: 'unstable', latestReceipt: null },
        { sessionId: 'relative', createdAt: 10, workspaceName: null, eligible: false, reason: 'workspace-unavailable', latestReceipt: null },
      ],
    })
    expect(calls).toBe(2)
  })

  it('marks a missing or duplicate second observation unstable', async () => {
    const first = [snapshot('missing', 'source:a', 2, '/work/missing'), snapshot('duplicate', 'source:b', 1, '/work/duplicate')]
    let calls = 0
    const catalog = new SessionCatalog(store(), {
      async listSnapshots() {
        calls += 1
        return calls === 1 ? first : [
          snapshot('duplicate', 'source:b', 1, '/work/duplicate'),
          snapshot('duplicate', 'source:b', 1, '/work/duplicate'),
        ]
      },
    }, { get() { return undefined } })
    const result = await catalog.list()
    expect(result.sessions.map(session => [session.sessionId, session.reason])).toEqual([
      ['missing', 'unstable'],
      ['duplicate', 'unstable'],
    ])
  })
})
