/** Host-owned revisions for the memory snapshot most recently shown to one Agent. */

import type { MemoryAgent } from './host-contracts.ts'
import type { MarkdownMemoryStore, WorkspaceScope } from './memory-store.ts'
import { MemoryConflictError } from './memory-store.ts'
import type { MemoryRevision } from './protocol.ts'

interface MemoryObservation {
  readonly globalRevision: MemoryRevision
  readonly workspace?: {
    readonly key: string
    readonly revision: MemoryRevision
  }
}

/** Raised when a model-facing write cannot be tied to memory that Agent observed. */
export class MemoryObservationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryObservationError'
  }
}

/** Binds prompt-time memory generations to live Agent identity. */
export class MemoryObservationRegistry {
  private readonly observations = new WeakMap<MemoryAgent, MemoryObservation>()

  constructor(private readonly store: MarkdownMemoryStore) {}

  /** Render model-visible memory while retaining its Host-only CAS generations. */
  render(agent?: MemoryAgent): string {
    const snapshot = this.store.renderContextSnapshot(agent?.session.header.cwd)
    if (agent !== undefined) {
      this.observations.set(agent, {
        globalRevision: snapshot.globalRevision,
        ...(snapshot.workspace === undefined ? {} : { workspace: snapshot.workspace }),
      })
    }
    return snapshot.text
  }

  requireGlobal(agent?: MemoryAgent): MemoryRevision {
    return this.require(agent).globalRevision
  }

  requireWorkspace(agent: MemoryAgent | undefined, scope: WorkspaceScope): MemoryRevision {
    const workspace = this.require(agent).workspace
    if (workspace === undefined || workspace.key !== scope.key) {
      throw new MemoryObservationError('Current Workspace memory was not present in this Agent context.')
    }
    return workspace.revision
  }

  advanceGlobal(agent: MemoryAgent, expected: MemoryRevision, next: MemoryRevision): void {
    const current = this.observations.get(agent)
    if (current?.globalRevision !== expected) return
    this.observations.set(agent, { ...current, globalRevision: next })
  }

  advanceWorkspace(agent: MemoryAgent, scope: WorkspaceScope, expected: MemoryRevision, next: MemoryRevision): void {
    const current = this.observations.get(agent)
    if (current?.workspace?.key !== scope.key || current.workspace.revision !== expected) return
    this.observations.set(agent, { ...current, workspace: { key: scope.key, revision: next } })
  }

  /** Hide opaque revisions while preserving a useful model-facing conflict. */
  static modelFacingError(error: unknown): never {
    if (error instanceof MemoryConflictError) {
      throw new MemoryObservationError(
        'Memory changed after this Agent read it. Review the refreshed memory context before updating again.',
      )
    }
    throw error
  }

  private require(agent?: MemoryAgent): MemoryObservation {
    if (agent === undefined) {
      throw new MemoryObservationError('memory_update requires an active Agent with an observed Memory Context.')
    }
    const observation = this.observations.get(agent)
    if (observation === undefined) {
      throw new MemoryObservationError('memory_update requires Memory Context to be assembled before the write.')
    }
    return observation
  }
}
