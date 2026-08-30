import { describe, expect, it } from 'vitest'
import {
  parseEmptyPayload,
  parseGlobalMemoryView,
  parseGlobalReplacePayload,
  parseGlobalReplaceResponse,
  parseMemoryStatus,
} from '../src/protocol.ts'

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
  })

  it('rejects unknown fields on both requests and responses', () => {
    expect(() => parseEmptyPayload({ extra: true })).toThrow(/exactly/)
    expect(() => parseGlobalReplacePayload({ expectedRevision: 'sha256:abc', content: '', path: '/tmp' })).toThrow(/exactly/)
    expect(() => parseMemoryStatus({ enabled: true, root: '/memory', globalBytes: 0, workspaceCount: 0, secret: true })).toThrow(/exactly/)
  })
})
