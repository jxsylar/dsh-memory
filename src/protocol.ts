/** Browser/Host wire values for the dedicated loopback Memory RPC channel. */

/** Opaque content revision used for compare-and-swap writes. */
export type MemoryRevision = string & { readonly __memoryRevision: unique symbol }

/** Browser-safe identifier resolved against the Host Workspace catalog. */
export type WorkspaceId = string & { readonly __workspaceId: unique symbol }

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

/** Browser-safe summary of one discovered Workspace. */
export interface WorkspaceSummary {
  workspaceId: WorkspaceId
  displayName: string
  revision: MemoryRevision
  recordCount: number
}

/** Closed record projection returned by the Workspace read endpoint. */
export interface WorkspaceRecordView {
  name: string
  description: string
  type: 'feedback' | 'project' | 'reference'
  content: string
}

/** Complete read-only Workspace projection returned to the Browser. */
export interface WorkspaceReadResponse extends WorkspaceSummary {
  index: string
  records: WorkspaceRecordView[]
}

/** Ordered catalog returned by the Workspace list endpoint. */
export interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[]
}

/** Deterministic reason why a persisted Session cannot be consolidated. */
export type SessionIneligibleReason = 'live' | 'missing-cwd' | 'workspace-unavailable' | 'unstable'

/** Browser-safe projection of one persisted Session snapshot. */
export type SessionSummary = {
  sessionId: string
  createdAt: number
  workspaceName: string | null
  latestReceipt: null
} & (
  | { eligible: true; reason: null }
  | { eligible: false; reason: SessionIneligibleReason }
)

/** Session candidate capability and ordered persisted Session list. */
export interface SessionListResponse {
  available: boolean
  sessions: SessionSummary[]
}

/** One Browser-proposed change in a canonical delete-then-put batch. */
export type WorkspaceCommitChange =
  | { action: 'delete'; name: string }
  | { action: 'put'; record: WorkspaceRecordView }

/** Revision-checked Workspace batch submitted through the loopback RPC. */
export interface WorkspaceCommitPayload {
  workspaceId: WorkspaceId
  expectedRevision: MemoryRevision
  changes: WorkspaceCommitChange[]
}

/** Result of one Workspace batch commit through the Web API. */
export type WorkspaceCommitResponse =
  | { status: 'committed'; revision: MemoryRevision }
  | { status: 'conflict'; currentRevision: MemoryRevision }

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

/** Parse a Browser request for one opaque Workspace id. */
export function parseWorkspaceReadPayload(value: unknown): { workspaceId: WorkspaceId } {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, ['workspaceId'], 'payload')
  return { workspaceId: requireWorkspaceId(record.workspaceId, 'payload.workspaceId') }
}

/** Parse and canonicalize a revision-checked Workspace mutation batch. */
export function parseWorkspaceCommitPayload(value: unknown): WorkspaceCommitPayload {
  const record = requireRecord(value, 'payload')
  requireExactKeys(record, ['workspaceId', 'expectedRevision', 'changes'], 'payload')
  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    throw new TypeError('payload.changes must be a non-empty array')
  }
  const changes: WorkspaceCommitChange[] = []
  const deletes = new Set<string>()
  const puts = new Set<string>()
  let reachedPuts = false
  for (const [index, candidate] of record.changes.entries()) {
    const label = `payload.changes[${index}]`
    const change = requireRecord(candidate, label)
    if (change.action === 'delete') {
      if (reachedPuts) throw new TypeError('payload.changes must place every delete before every put')
      requireExactKeys(change, ['action', 'name'], label)
      const name = requireWorkspaceMemoryName(change.name, `${label}.name`)
      if (deletes.has(name)) throw new TypeError(`${label}.name duplicates an earlier delete`)
      deletes.add(name)
      changes.push({ action: 'delete', name })
    } else if (change.action === 'put') {
      reachedPuts = true
      requireExactKeys(change, ['action', 'record'], label)
      const parsed = parseWorkspaceRecord(change.record, `${label}.record`)
      if (puts.has(parsed.name)) throw new TypeError(`${label}.record.name duplicates an earlier put`)
      puts.add(parsed.name)
      changes.push({ action: 'put', record: parsed })
    } else {
      throw new TypeError(`${label}.action must be delete or put`)
    }
  }
  return {
    workspaceId: requireWorkspaceId(record.workspaceId, 'payload.workspaceId'),
    expectedRevision: requireRevision(record.expectedRevision, 'payload.expectedRevision'),
    changes,
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

/** Parse the closed Workspace catalog on both sides of the Host/Browser wire. */
export function parseWorkspaceListResponse(value: unknown): WorkspaceListResponse {
  const record = requireRecord(value, 'workspace list response')
  requireExactKeys(record, ['workspaces'], 'workspace list response')
  if (!Array.isArray(record.workspaces)) throw new TypeError('workspace list response.workspaces must be an array')
  return {
    workspaces: record.workspaces.map((entry, index) => parseWorkspaceSummary(entry, `workspace list response.workspaces[${index}]`)),
  }
}

/** Parse one complete read-only Workspace projection on both sides of the wire. */
export function parseWorkspaceReadResponse(value: unknown): WorkspaceReadResponse {
  const record = requireRecord(value, 'workspace read response')
  requireExactKeys(record, ['workspaceId', 'displayName', 'revision', 'recordCount', 'index', 'records'], 'workspace read response')
  const summary = parseWorkspaceSummaryFields(record, 'workspace read response')
  if (typeof record.index !== 'string') throw new TypeError('workspace read response.index must be a string')
  if (!Array.isArray(record.records)) throw new TypeError('workspace read response.records must be an array')
  const records = record.records.map((entry, index) => parseWorkspaceRecord(entry, `workspace read response.records[${index}]`))
  if (records.length !== summary.recordCount) {
    throw new TypeError('workspace read response.recordCount must match records length')
  }
  return { ...summary, index: record.index, records }
}

/** Parse a Workspace commit result before either side trusts its revision. */
export function parseWorkspaceCommitResponse(value: unknown): WorkspaceCommitResponse {
  const record = requireRecord(value, 'workspace commit response')
  if (record.status === 'committed') {
    requireExactKeys(record, ['status', 'revision'], 'workspace commit response')
    return { status: 'committed', revision: requireRevision(record.revision, 'workspace commit response.revision') }
  }
  if (record.status === 'conflict') {
    requireExactKeys(record, ['status', 'currentRevision'], 'workspace commit response')
    return { status: 'conflict', currentRevision: requireRevision(record.currentRevision, 'workspace commit response.currentRevision') }
  }
  throw new TypeError('workspace commit response.status must be committed or conflict')
}

/** Parse the Session candidate projection on both sides of the Host/Browser wire. */
export function parseSessionListResponse(value: unknown): SessionListResponse {
  const record = requireRecord(value, 'session list response')
  requireExactKeys(record, ['available', 'sessions'], 'session list response')
  if (typeof record.available !== 'boolean') throw new TypeError('session list response.available must be a boolean')
  if (!Array.isArray(record.sessions)) throw new TypeError('session list response.sessions must be an array')
  if (!record.available && record.sessions.length !== 0) {
    throw new TypeError('session list response.sessions must be empty when unavailable')
  }
  return {
    available: record.available,
    sessions: record.sessions.map((entry, index) => parseSessionSummary(entry, `session list response.sessions[${index}]`)),
  }
}

function parseSessionSummary(value: unknown, label: string): SessionSummary {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['sessionId', 'createdAt', 'workspaceName', 'eligible', 'reason', 'latestReceipt'], label)
  const sessionId = requireNonEmptySingleLine(record.sessionId, `${label}.sessionId`)
  if (!isNonNegativeInteger(record.createdAt)) throw new TypeError(`${label}.createdAt must be a non-negative integer`)
  const workspaceName = record.workspaceName === null
    ? null
    : requireNonEmptySingleLine(record.workspaceName, `${label}.workspaceName`)
  if (record.latestReceipt !== null) throw new TypeError(`${label}.latestReceipt must be null before receipts are implemented`)
  const base = { sessionId, createdAt: record.createdAt, workspaceName, latestReceipt: null } as const
  if (record.eligible === true) {
    if (record.reason !== null) throw new TypeError(`${label}.reason must be null when eligible`)
    return { ...base, eligible: true, reason: null }
  }
  if (record.eligible !== false || !isSessionIneligibleReason(record.reason)) {
    throw new TypeError(`${label}.reason must explain an ineligible Session`)
  }
  return { ...base, eligible: false, reason: record.reason }
}

function parseWorkspaceSummary(value: unknown, label: string): WorkspaceSummary {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['workspaceId', 'displayName', 'revision', 'recordCount'], label)
  return parseWorkspaceSummaryFields(record, label)
}

function parseWorkspaceSummaryFields(record: Record<string, unknown>, label: string): WorkspaceSummary {
  const displayName = requireNonEmptySingleLine(record.displayName, `${label}.displayName`)
  if (!isNonNegativeInteger(record.recordCount)) {
    throw new TypeError(`${label}.recordCount must be a non-negative integer`)
  }
  return {
    workspaceId: requireWorkspaceId(record.workspaceId, `${label}.workspaceId`),
    displayName,
    revision: requireRevision(record.revision, `${label}.revision`),
    recordCount: record.recordCount,
  }
}

function parseWorkspaceRecord(value: unknown, label: string): WorkspaceRecordView {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['name', 'description', 'type', 'content'], label)
  const name = requireWorkspaceMemoryName(record.name, `${label}.name`)
  const description = requireNonEmptySingleLine(record.description, `${label}.description`)
  if (record.type !== 'feedback' && record.type !== 'project' && record.type !== 'reference') {
    throw new TypeError(`${label}.type must be feedback, project, or reference`)
  }
  if (typeof record.content !== 'string' || record.content.trim() === '') {
    throw new TypeError(`${label}.content must be a non-empty string`)
  }
  return { name, description, type: record.type, content: record.content }
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

function requireWorkspaceId(value: unknown, label: string): WorkspaceId {
  if (typeof value !== 'string' || !/^workspace:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be an opaque Workspace id`)
  }
  return value as WorkspaceId
}

function requireNonEmptySingleLine(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty single line`)
  }
  return value
}

function requireWorkspaceMemoryName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new TypeError(`${label} must be a kebab-case Workspace memory name`)
  }
  return value
}

function isSessionIneligibleReason(value: unknown): value is SessionIneligibleReason {
  return value === 'live' || value === 'missing-cwd' || value === 'workspace-unavailable' || value === 'unstable'
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
