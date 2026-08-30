import { describe, expect, it } from 'vitest'
import { apply, inject, type BrowserContext } from '../src/client/index.ts'
import {
  buildWorkspaceChanges,
  memoryButtonDisabledStyle,
  memoryButtonHoverStyles,
  memoryButtonPressedStyle,
  memorySectionStyles,
  workspaceDraftIssue,
  type WorkspaceDraftRecord,
} from '../src/client/MemorySection.tsx'
import { en, zh } from '../src/client/locales.ts'

describe('Browser locale integration', () => {
  it('registers balanced dictionaries and follows the active DSH locale', () => {
    let active: 'zh' | 'en' = 'en'
    let registered: { readonly zh: Readonly<Record<string, string>>; readonly en: Readonly<Record<string, string>> } | undefined
    let registration: Parameters<BrowserContext['slots']['register']>[0] | undefined

    const ctx: BrowserContext = {
      connection: {
        isLoopback: true,
        rpc: {
          call: async () => { throw new Error('RPC is not used by this test') },
        },
      },
      locale: {
        register(_namespace, dictionaries) {
          registered = dictionaries
          return () => undefined
        },
        bind() {
          return (key, params) => {
            const template = (active === 'zh' ? zh : en)[key]
            return template.replace(/\{(\w+)\}/g, (match, name: string) =>
              params !== undefined && name in params ? String(params[name]) : match)
          }
        },
      },
      slots: {
        inject(_name, callback) { callback() },
        register(options) {
          registration = options
          return () => undefined
        },
      },
      effect(callback) { callback() },
    }

    apply(ctx)

    expect(inject).toContain('locale')
    expect(Object.keys(registered?.en ?? {})).toEqual(Object.keys(registered?.zh ?? {}))
    expect(registration?.locale).toBe('settings.memory')
    expect(registration?.label()).toBe('Memory')
    active = 'zh'
    expect(registration?.label()).toBe('记忆')
    expect(ctx.locale.bind('settings.memory')('bytes', { count: 12 })).toBe('12 字节')
  })
})

describe('Memory section responsive layout', () => {
  it('keeps wide content inside the Settings section and allows controls to wrap', () => {
    expect(memorySectionStyles.page).toMatchObject({
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '100%',
      minWidth: 0,
    })
    expect(memorySectionStyles.header).toMatchObject({ flexWrap: 'wrap', minWidth: 0 })
    expect(memorySectionStyles.status).toMatchObject({ maxWidth: '100%', minWidth: 0 })
    expect(memorySectionStyles.path).toMatchObject({ overflowWrap: 'anywhere', minWidth: 0 })
    expect(memorySectionStyles.tabs).toMatchObject({ flexWrap: 'wrap', maxWidth: '100%', minWidth: 0 })
    expect(memorySectionStyles.editor).toMatchObject({ width: '100%', maxWidth: '100%', minWidth: 0 })
    expect(memorySectionStyles.actions).toMatchObject({ flexWrap: 'wrap', justifyContent: 'flex-end' })
    expect(memorySectionStyles.workspaceActions).toMatchObject({ marginTop: 16 })
  })
})

describe('Memory section tab selection', () => {
  it('uses the same border property for active and inactive tabs', () => {
    expect(memorySectionStyles.tab).toMatchObject({ borderBottom: '2px solid transparent' })
    expect(memorySectionStyles.activeTab).toMatchObject({ borderBottom: '2px solid #5b5bd6' })
    expect(memorySectionStyles.activeTab).not.toHaveProperty('borderBottomColor')
  })
})

describe('Memory button interaction feedback', () => {
  it('defines hover, press, and disabled feedback for every button variant', () => {
    expect(Object.keys(memoryButtonHoverStyles)).toEqual(['default', 'primary', 'danger', 'tab', 'workspace'])
    expect(memoryButtonHoverStyles.default).toMatchObject({ transform: 'translateY(-1px)' })
    expect(memoryButtonHoverStyles.primary).toHaveProperty('filter', 'brightness(1.1)')
    expect(memoryButtonHoverStyles.danger).toHaveProperty('background')
    expect(memoryButtonHoverStyles.tab).toHaveProperty('background')
    expect(memoryButtonHoverStyles.workspace).toHaveProperty('boxShadow')
    expect(memoryButtonPressedStyle).toMatchObject({ transform: 'translateY(0) scale(0.98)' })
    expect(memoryButtonDisabledStyle).toMatchObject({ cursor: 'not-allowed', transform: 'none' })
  })
})

describe('Memory Workspace Browser API', () => {
  it('uses opaque ids and parses list/read/commit responses before rendering', async () => {
    const workspaceId = `workspace:${'a'.repeat(64)}`
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    let registration: Parameters<BrowserContext['slots']['register']>[0] | undefined
    const ctx: BrowserContext = {
      connection: {
        isLoopback: true,
        rpc: {
          async call(_channel, endpoint, payload) {
            calls.push({ endpoint, payload })
            if (endpoint === 'workspaces/list') {
              return { ok: true, value: { workspaces: [{
                workspaceId,
                displayName: 'dsh-memory',
                revision: 'sha256:list',
                recordCount: 1,
              }] } }
            }
            if (endpoint === 'workspace/read') {
              return { ok: true, value: {
                workspaceId,
                displayName: 'dsh-memory',
                revision: 'sha256:read',
                recordCount: 1,
                index: '- [browser-contract](browser-contract.md)',
                records: [{
                  name: 'browser-contract',
                  description: 'Browser parses Host values.',
                  type: 'project',
                  content: 'Treat the wire as hostile.\n',
                }],
              } }
            }
            if (endpoint === 'workspace/commit') {
              return { ok: true, value: { status: 'committed', revision: 'sha256:committed' } }
            }
            if (endpoint === 'sessions/list') {
              return { ok: true, value: { available: true, sessions: [{
                sessionId: 'session-browser',
                createdAt: 100,
                workspaceName: 'dsh-memory',
                eligible: false,
                reason: 'live',
                latestReceipt: null,
              }] } }
            }
            throw new Error(`unexpected endpoint: ${endpoint}`)
          },
        },
      },
      locale: {
        register() { return () => undefined },
        bind() { return key => en[key] },
      },
      slots: {
        inject(_name, callback) { callback() },
        register(options) { registration = options; return () => undefined },
      },
      effect(callback) { callback() },
    }

    apply(ctx)
    const api = registration?.inject().api
    if (api === undefined) throw new Error('expected Memory settings API')
    const list = await api.listWorkspaces()
    expect(list).toMatchObject({ workspaces: [{ workspaceId, recordCount: 1 }] })
    const read = await api.readWorkspace(list.workspaces[0]!.workspaceId)
    expect(read).toMatchObject({ records: [{ name: 'browser-contract' }] })
    await expect(api.commitWorkspace({
      workspaceId: list.workspaces[0]!.workspaceId,
      expectedRevision: read.revision,
      changes: [{ action: 'delete', name: 'browser-contract' }],
    })).resolves.toEqual({ status: 'committed', revision: 'sha256:committed' })
    await expect(api.listSessions()).resolves.toMatchObject({
      available: true,
      sessions: [{ sessionId: 'session-browser', reason: 'live' }],
    })
    expect(calls).toEqual([
      { endpoint: 'workspaces/list', payload: {} },
      { endpoint: 'workspace/read', payload: { workspaceId } },
      {
        endpoint: 'workspace/commit',
        payload: {
          workspaceId,
          expectedRevision: 'sha256:read',
          changes: [{ action: 'delete', name: 'browser-contract' }],
        },
      },
      { endpoint: 'sessions/list', payload: {} },
    ])
  })
})

describe('Workspace draft batching', () => {
  const original = [{
    name: 'alpha',
    description: 'Original alpha.',
    type: 'project' as const,
    content: 'Alpha.\n',
  }, {
    name: 'beta',
    description: 'Original beta.',
    type: 'reference' as const,
    content: 'Beta.\n',
  }]

  it('builds deterministic deletes before changed and new puts', () => {
    const drafts: WorkspaceDraftRecord[] = [{
      draftId: 'existing:alpha',
      originalName: 'alpha',
      name: 'renamed-alpha',
      description: 'Renamed alpha.',
      type: 'feedback',
      content: 'Renamed.\n',
    }, {
      draftId: 'new:1',
      name: 'gamma',
      description: 'New gamma.',
      type: 'project',
      content: 'Gamma.\n',
    }]
    expect(buildWorkspaceChanges(original, drafts)).toEqual([
      { action: 'delete', name: 'alpha' },
      { action: 'delete', name: 'beta' },
      { action: 'put', record: {
        name: 'gamma',
        description: 'New gamma.',
        type: 'project',
        content: 'Gamma.\n',
      } },
      { action: 'put', record: {
        name: 'renamed-alpha',
        description: 'Renamed alpha.',
        type: 'feedback',
        content: 'Renamed.\n',
      } },
    ])
  })

  it('detects invalid drafts and emits no changes for an untouched copy', () => {
    const untouched = original.map(record => ({ ...record, draftId: `existing:${record.name}`, originalName: record.name }))
    expect(buildWorkspaceChanges(original, untouched)).toEqual([])
    expect(workspaceDraftIssue(untouched)).toBeUndefined()
    expect(workspaceDraftIssue([...untouched, { ...untouched[0]!, draftId: 'duplicate' }])).toBe('duplicate-name')
    expect(workspaceDraftIssue([{ ...untouched[0]!, name: '../escape' }])).toBe('name')
  })
})
