/** Read-only Session eligibility projection for the Memory settings page. */

import type { MarkdownMemoryStore } from './memory-store.ts'
import type { MemoryAgentRegistry, MemorySessionPersistence, MemorySessionSnapshot } from './host-contracts.ts'
import type { SessionListResponse, SessionSummary } from './protocol.ts'

/** Builds a stable candidate list without loading complete Session event logs. */
export class SessionCatalog {
  constructor(
    private readonly store: MarkdownMemoryStore,
    private readonly persistence: MemorySessionPersistence,
    private readonly agents: MemoryAgentRegistry,
  ) {}

  /** Observe each snapshot twice and classify only unchanged, non-live Sessions as eligible. */
  async list(signal?: AbortSignal): Promise<SessionListResponse> {
    const first = await this.persistence.listSnapshots(signal)
    signal?.throwIfAborted()
    const second = await this.persistence.listSnapshots(signal)
    signal?.throwIfAborted()

    const secondById = groupById(second)
    const duplicateFirstIds = duplicateIds(first)
    const sessions = uniqueById(first)
      .map(snapshot => this.classify(snapshot, secondById, duplicateFirstIds))
      .sort((left, right) => right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId, 'en'))
    return { available: true, sessions }
  }

  private classify(
    snapshot: MemorySessionSnapshot,
    secondById: ReadonlyMap<string, readonly MemorySessionSnapshot[]>,
    duplicateFirstIds: ReadonlySet<string>,
  ): SessionSummary {
    const base = {
      sessionId: snapshot.header.id,
      createdAt: snapshot.header.createdAt,
      latestReceipt: null,
    } as const
    if (this.agents.get(snapshot.header.id) !== undefined) {
      return { ...base, workspaceName: workspaceName(this.store, snapshot.header.cwd), eligible: false, reason: 'live' }
    }
    if (snapshot.header.cwd === undefined) {
      return { ...base, workspaceName: null, eligible: false, reason: 'missing-cwd' }
    }

    let resolvedWorkspaceName: string
    try {
      resolvedWorkspaceName = this.store.workspaceDisplayNameForCwd(snapshot.header.cwd)
    } catch {
      return { ...base, workspaceName: null, eligible: false, reason: 'workspace-unavailable' }
    }

    const matching = secondById.get(snapshot.header.id)
    if (duplicateFirstIds.has(snapshot.header.id)
      || matching?.length !== 1
      || matching[0]?.revision !== snapshot.revision) {
      return { ...base, workspaceName: resolvedWorkspaceName, eligible: false, reason: 'unstable' }
    }
    return { ...base, workspaceName: resolvedWorkspaceName, eligible: true, reason: null }
  }
}

function workspaceName(store: MarkdownMemoryStore, cwd?: string): string | null {
  if (cwd === undefined) return null
  try {
    return store.workspaceDisplayNameForCwd(cwd)
  } catch {
    return null
  }
}

function groupById(snapshots: readonly MemorySessionSnapshot[]): Map<string, MemorySessionSnapshot[]> {
  const grouped = new Map<string, MemorySessionSnapshot[]>()
  for (const snapshot of snapshots) {
    const values = grouped.get(snapshot.header.id) ?? []
    values.push(snapshot)
    grouped.set(snapshot.header.id, values)
  }
  return grouped
}

function duplicateIds(snapshots: readonly MemorySessionSnapshot[]): Set<string> {
  return new Set([...groupById(snapshots)].filter(([, values]) => values.length !== 1).map(([id]) => id))
}

function uniqueById(snapshots: readonly MemorySessionSnapshot[]): MemorySessionSnapshot[] {
  const unique = new Map<string, MemorySessionSnapshot>()
  for (const snapshot of snapshots) if (!unique.has(snapshot.header.id)) unique.set(snapshot.header.id, snapshot)
  return [...unique.values()]
}
