import { describe, expect, it } from 'vitest'
import {
  parseEmptyPayload,
  parseGlobalMemoryView,
  parseGlobalReplacePayload,
  parseGlobalReplaceResponse,
  parseMemoryStatus,
  parseSessionListResponse,
  parseWorkspaceCommitPayload,
  parseWorkspaceCommitResponse,
  parseWorkspaceListResponse,
  parseWorkspaceReadPayload,
  parseWorkspaceReadResponse,
} from '../src/protocol.ts'

const WORKSPACE_ID = `workspace:${'a'.repeat(64)}`

describe('Memory RPC protocol', () => {
  it('accepts closed valid values', () => {
    expect(parseEmptyPayload({})).toEqual({})
    expect(parseGlobalReplacePayload({ expectedRevision: 'sha256:abc', content: '# Memory\n' })).toEqual({
      expectedRevision: 'sha256:abc',
      content: '# Memory\n',
    })
    expect(parseMemoryStatus({ enabled: true, root: '/memory', globalBytes: 10, workspaceCount: 2 })).toEqual({
      enabled: true,
      root: '/memory',
      globalBytes: 10,
      workspaceCount: 2,
    })
    expect(parseGlobalMemoryView({ content: '# Memory\n', revision: 'sha256:abc' })).toEqual({
      content: '# Memory\n',
      revision: 'sha256:abc',
    })
    expect(parseGlobalReplaceResponse({ status: 'committed', revision: 'sha256:def' })).toEqual({
      status: 'committed',
      revision: 'sha256:def',
    })
    expect(parseWorkspaceReadPayload({ workspaceId: WORKSPACE_ID })).toEqual({ workspaceId: WORKSPACE_ID })
    expect(parseWorkspaceListResponse({ workspaces: [{
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 1,
    }] })).toEqual({ workspaces: [{
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 1,
    }] })
    expect(parseWorkspaceReadResponse({
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 1,
      index: '- [project-rule](project-rule.md)',
      records: [{
        name: 'project-rule',
        description: 'One project rule.',
        type: 'project',
        content: 'Keep it local.\n',
      }],
    })).toMatchObject({ workspaceId: WORKSPACE_ID, recordCount: 1 })
    expect(parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [
        { action: 'delete', name: 'old-record' },
        { action: 'put', record: {
          name: 'new-record',
          description: 'A replacement record.',
          type: 'project',
          content: 'Replacement.\n',
        } },
      ],
    })).toMatchObject({ workspaceId: WORKSPACE_ID, changes: [{ action: 'delete' }, { action: 'put' }] })
    expect(parseWorkspaceCommitResponse({ status: 'conflict', currentRevision: 'sha256:newer' }))
      .toEqual({ status: 'conflict', currentRevision: 'sha256:newer' })
    expect(parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-1',
      createdAt: 42,
      workspaceName: 'dsh-memory',
      eligible: true,
      reason: null,
      latestReceipt: null,
    }] })).toMatchObject({ available: true, sessions: [{ sessionId: 'session-1', eligible: true }] })
  })

  it('rejects unknown fields on both requests and responses', () => {
    expect(() => parseEmptyPayload({ extra: true })).toThrow(/exactly/)
    expect(() => parseGlobalReplacePayload({ expectedRevision: 'sha256:abc', content: '', path: '/tmp' })).toThrow(/exactly/)
    expect(() => parseMemoryStatus({ enabled: true, root: '/memory', globalBytes: 0, workspaceCount: 0, secret: true })).toThrow(/exactly/)
    expect(() => parseWorkspaceReadPayload({ workspaceId: WORKSPACE_ID, path: '/memory/workspaces/internal' })).toThrow(/exactly/)
    expect(() => parseWorkspaceReadPayload({ workspaceId: 'internal-key' })).toThrow(/opaque/)
    expect(() => parseWorkspaceListResponse({ workspaces: [{
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 0,
      internalKey: 'dsh-memory-deadbeefdeadbeef',
    }] })).toThrow(/exactly/)
    expect(() => parseWorkspaceReadResponse({
      workspaceId: WORKSPACE_ID,
      displayName: 'dsh-memory',
      revision: 'sha256:abc',
      recordCount: 2,
      index: '',
      records: [],
    })).toThrow(/match/)
    expect(() => parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [],
    })).toThrow(/non-empty/)
    expect(() => parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [
        { action: 'put', record: { name: 'valid', description: 'Valid.', type: 'project', content: 'Valid.\n' } },
        { action: 'delete', name: 'old-record' },
      ],
    })).toThrow(/delete before/)
    expect(() => parseWorkspaceCommitPayload({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 'sha256:abc',
      changes: [{ action: 'put', record: {
        name: '../escape',
        description: 'Unsafe.',
        type: 'project',
        content: 'Unsafe.\n',
      } }],
    })).toThrow(/kebab-case/)
    expect(() => parseWorkspaceCommitResponse({ status: 'committed', revision: 'sha256:new', path: '/tmp' }))
      .toThrow(/exactly/)
    expect(() => parseSessionListResponse({ available: false, sessions: [{ sessionId: 'hidden' }] })).toThrow(/empty/)
    expect(() => parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-1',
      createdAt: 42,
      workspaceName: 'dsh-memory',
      eligible: true,
      reason: 'live',
      latestReceipt: null,
    }] })).toThrow(/null/)
    expect(() => parseSessionListResponse({ available: true, sessions: [{
      sessionId: 'session-1',
      createdAt: 42,
      workspaceName: 'dsh-memory',
      eligible: false,
      reason: 'unknown',
      latestReceipt: null,
    }] })).toThrow(/explain/)
  })
})
