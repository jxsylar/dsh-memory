/** Browser/Host wire values for the dedicated loopback Memory RPC channel. */

/** Opaque content revision used for compare-and-swap writes. */
export type MemoryRevision = string & { readonly __memoryRevision: unique symbol }

/** Summary displayed at the top of the Memory settings section. */
export interface MemoryStatus {
  enabled: true
  root: string
  globalBytes: number
  workspaceCount: number
}

/** Complete global memory document and its current revision. */
export interface GlobalMemoryView {
  content: string
  revision: MemoryRevision
}

/** Result of replacing the global document through the Web API. */
export type GlobalReplaceResponse =
  | { status: 'committed'; revision: MemoryRevision }
  | { status: 'conflict'; currentRevision: MemoryRevision }

/** Minimal RPC error vocabulary accepted by the Connection envelope. */
export interface MemoryRpcError {
  code: 'bad-request' | 'cancelled' | 'internal'
  message: string
  details: Record<string, unknown>
}

/** Connection-compatible result returned by one Memory RPC call. */
export type MemoryRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryRpcError }

/** Parse an empty-object request payload. */
export function parseEmptyPayload(value: unknown): Record<string, never> {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, [], 'payload')
  return {}
}

/** Parse a revision-checked global replacement request. */
export function parseGlobalReplacePayload(value: unknown): {
  expectedRevision: MemoryRevision
  content: string
} {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, ['expectedRevision', 'content'], 'payload')
  if (typeof record.expectedRevision !== 'string' || !record.expectedRevision.startsWith('sha256:')) {
    throw new TypeError('payload.expectedRevision must be a sha256 revision')
  }
  if (typeof record.content !== 'string') throw new TypeError('payload.content must be a string')
  return {
    expectedRevision: record.expectedRevision as MemoryRevision,
    content: record.content,
  }
}

/** Parse a Host status response before the Browser renders it. */
export function parseMemoryStatus(value: unknown): MemoryStatus {
  const record = requireRecord(value, 'status response')
  requireExactKeys(record, ['enabled', 'root', 'globalBytes', 'workspaceCount'], 'status response')
  if (record.enabled !== true) throw new TypeError('status response.enabled must be true')
  if (typeof record.root !== 'string') throw new TypeError('status response.root must be a string')
  if (!isNonNegativeInteger(record.globalBytes)) throw new TypeError('status response.globalBytes must be a non-negative integer')
  if (!isNonNegativeInteger(record.workspaceCount)) throw new TypeError('status response.workspaceCount must be a non-negative integer')
  return {
    enabled: true,
    root: record.root,
    globalBytes: record.globalBytes,
    workspaceCount: record.workspaceCount,
  }
}

/** Parse a global document response before the Browser edits it. */
export function parseGlobalMemoryView(value: unknown): GlobalMemoryView {
  const record = requireRecord(value, 'global response')
  requireExactKeys(record, ['content', 'revision'], 'global response')
  if (typeof record.content !== 'string') throw new TypeError('global response.content must be a string')
  if (typeof record.revision !== 'string' || !record.revision.startsWith('sha256:')) {
    throw new TypeError('global response.revision must be a sha256 revision')
  }
  return { content: record.content, revision: record.revision as MemoryRevision }
}

/** Parse a global replacement response before the Browser updates its revision. */
export function parseGlobalReplaceResponse(value: unknown): GlobalReplaceResponse {
  const record = requireRecord(value, 'replace response')
  if (record.status === 'committed') {
    requireExactKeys(record, ['status', 'revision'], 'replace response')
    return { status: 'committed', revision: requireRevision(record.revision, 'replace response.revision') }
  }
  if (record.status === 'conflict') {
    requireExactKeys(record, ['status', 'currentRevision'], 'replace response')
    return { status: 'conflict', currentRevision: requireRevision(record.currentRevision, 'replace response.currentRevision') }
  }
  throw new TypeError('replace response.status must be committed or conflict')
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly: ${wanted.join(', ') || '(no fields)'}`)
  }
}

function requireRevision(value: unknown, label: string): MemoryRevision {
  if (typeof value !== 'string' || !value.startsWith('sha256:')) {
    throw new TypeError(`${label} must be a sha256 revision`)
  }
  return value as MemoryRevision
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
