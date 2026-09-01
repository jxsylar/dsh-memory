import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index.ts'
import type { MarkdownMemoryStore } from '../src/memory-store.ts'
import type { MemoryRpcResult } from '../src/protocol.ts'

const roots: string[] = []
const previousDshHome = process.env.DSH_HOME

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
})

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-'))
  roots.push(root)
  process.env.DSH_HOME = root
  return root
}

describe('Host Cordis composition', () => {
  it('loads in Headless without Web-only services', async () => {
    isolatedHome()
    const ctx = new Context()
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    expect(ctx.get('memoryStore')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('memoryStore')).toBeUndefined()
  })

  it('registers prompt, tool, and loopback RPC Consumers when their services exist', async () => {
    isolatedHome()
    const ctx = new Context()
    const sections: unknown[] = []
    const contexts: unknown[] = []
    const tools: unknown[] = []
    const channels: unknown[] = []
    let rpcHandler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<MemoryRpcResult<unknown>>) | undefined
    ctx.provide('systemPrompt', {
      section(value: unknown) { sections.push(value); return () => undefined },
      context(value: unknown) { contexts.push(value); return () => undefined },
    })
    ctx.provide('tools', {
      register(value: unknown) { tools.push(value); return () => undefined },
    })
    ctx.provide('connection', {
      rpc: {
        handle(channel: string, handler: typeof rpcHandler, options: unknown) {
          rpcHandler = handler
          channels.push({ channel, handler, options })
          return async () => undefined
        },
      },
    })
    ctx.provide('sessionPersistence', {
      async inspect(id: string) {
        return { meta: { id, createdAt: id === 'session-eligible' ? 2 : 1, cwd: '/work/plugin-rpc' }, events: [] }
      },
      async listSnapshots() {
        return [
          { header: { id: 'session-eligible', createdAt: 2, cwd: '/work/plugin-rpc' }, revision: 'source:a' },
          { header: { id: 'session-live', createdAt: 1, cwd: '/work/plugin-rpc' }, revision: 'source:b' },
          { header: { id: 'session-archived', createdAt: 0, cwd: '/work/plugin-rpc' }, revision: 'source:c' },
        ]
      },
    })
    const liveSession = { id: 'session-live' }
    ctx.provide('agents', { get(id: string) { return id === 'session-live' ? { session: liveSession } : undefined } })
    ctx.provide('sessions', { async flush() { return true } })
    ctx.provide('workspaceRegistry', {
      archivedSessionIds: ['session-archived'],
      async create(path: string) {
        return { path, async attachSession() {} }
      },
    })
    ctx.provide('sessionProjections', {
      snapshot(session: unknown) {
        expect(session).toBe(liveSession)
        return { values: { title: 'Live memory review' } }
      },
    })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot(header: { id: string }) {
        expect(header.id).toBe('session-eligible')
        return { values: { title: 'Eligible memory review' } }
      },
    })
    ctx.provide('llm', {
      listProviders() { return [{ id: 'deepseek-official', name: 'DeepSeek' }] },
      async listModels(provider: string) {
        return [
          { provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputModalities: ['text'] },
          { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] },
        ]
      },
      async resolveModelInfo(provider: string, model: string) {
        return { provider, id: model, name: model, defaultMaxTokens: 16_384 }
      },
    })
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    expect(sections).toHaveLength(1)
    expect(contexts).toHaveLength(1)
    expect(tools).toMatchObject([{ name: 'memory_update' }])
    expect(channels).toMatchObject([{ channel: '/memory', options: { authority: 'loopback' } }])

    const memory = ctx.get('memoryStore') as MarkdownMemoryStore
    const scope = memory.scopeForCwd('/work/plugin-rpc')
    const empty = await memory.readWorkspace(scope)
    await memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: 'rpc-visible',
        description: 'Visible through the read-only RPC.',
        type: 'project',
        content: 'RPC content.\n',
      } }],
    })
    const signal = new AbortController().signal
    const list = await rpcHandler?.('workspaces/list', {}, signal)
    expect(list).toMatchObject({ ok: true, value: { workspaces: [{ displayName: 'plugin-rpc', recordCount: 1 }] } })
    if (list?.ok !== true) throw new Error('expected Workspace list response')
    const workspaceId = (list.value as { workspaces: Array<{ workspaceId: string }> }).workspaces[0]!.workspaceId
    const read = await rpcHandler?.('workspace/read', { workspaceId }, signal)
    expect(read).toMatchObject({ ok: true, value: { displayName: 'plugin-rpc', records: [{ name: 'rpc-visible' }] } })
    expect(JSON.stringify(read)).not.toContain(scope.key)
    if (read?.ok !== true) throw new Error('expected Workspace read response')
    const revision = (read.value as { revision: string }).revision
    const committed = await rpcHandler?.('workspace/commit', {
      workspaceId,
      expectedRevision: revision,
      changes: [{ action: 'put', record: {
        name: 'rpc-created',
        description: 'Created through one RPC batch.',
        type: 'project',
        content: 'Created.\n',
      } }],
    }, signal)
    expect(committed).toMatchObject({ ok: true, value: { status: 'committed' } })
    const conflict = await rpcHandler?.('workspace/commit', {
      workspaceId,
      expectedRevision: revision,
      changes: [{ action: 'delete', name: 'rpc-visible' }],
    }, signal)
    expect(conflict).toMatchObject({ ok: true, value: { status: 'conflict' } })
    if (committed?.ok !== true) throw new Error('expected Workspace commit response')
    const committedRevision = (committed.value as { revision: string }).revision
    expect(await rpcHandler?.('workspace/commit', {
      workspaceId,
      expectedRevision: committedRevision,
      changes: [{ action: 'delete', name: 'missing-record' }],
    }, signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await rpcHandler?.('sessions/list', {}, signal)).toMatchObject({
      ok: true,
      value: {
        available: true,
        sessions: [
          { sessionId: 'session-eligible', title: 'Eligible memory review', eligible: true },
          { sessionId: 'session-live', title: 'Live memory review', eligible: false, reason: 'live' },
        ],
      },
    })
    expect(await rpcHandler?.('sessions/consolidate', { sessionId: 'session-archived' }, signal))
      .toMatchObject({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('is archived') } })
    const models = await rpcHandler?.('models/read', {}, signal)
    expect(models).toMatchObject({
      ok: true,
      value: {
        selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        debugEnabled: false,
        providers: [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }],
      },
    })
    if (models?.ok !== true) throw new Error('expected model catalog response')
    const modelRevision = (models.value as { revision: string }).revision
    expect(await rpcHandler?.('models/select', {
      expectedRevision: modelRevision,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      debugEnabled: true,
    }, signal)).toMatchObject({ ok: true, value: { status: 'committed' } })
    expect(await rpcHandler?.('models/select', {
      expectedRevision: modelRevision,
      provider: 'unknown',
      model: 'unknown',
      debugEnabled: false,
    }, signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await rpcHandler?.('sessions/consolidate', { sessionId: 'session-eligible' }, signal))
      .toMatchObject({ ok: true, value: { status: 'no-change', recovered: false, attempt: 1, changeCount: 0 } })
    expect(await rpcHandler?.('sessions/list', {}, signal)).toMatchObject({
      ok: true,
      value: { sessions: [
        { sessionId: 'session-eligible', latestReceipt: { state: 'no-change', current: true } },
        { sessionId: 'session-live', latestReceipt: null },
      ] },
    })
    expect(await rpcHandler?.('workspace/read', { workspaceId, cwd: '/work/plugin-rpc' }, signal))
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await rpcHandler?.('workspace/commit', {
      workspaceId,
      expectedRevision: revision,
      changes: [{ action: 'delete', name: 'rpc-visible' }],
      directory: scope.directory,
    }, signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await fiber.dispose()
  })
})
