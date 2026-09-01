/** Dedicated DSH Workspace placement for internal consolidation audit Sessions. */

import { mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'

export const CONSOLIDATION_WORKSPACE_TITLE = 'Memory Consolidation'
export const CONSOLIDATION_WORKSPACE_DIRECTORY = 'consolidator-workspace'

/** Match only the plugin-owned operational cwd without resolving arbitrary Session paths. */
export function isConsolidationWorkspaceCwd(cwd: string | undefined, directory: string): boolean {
  if (cwd === undefined || !isAbsolute(cwd)) return false
  const candidate = resolve(cwd)
  const expected = resolve(directory)
  if (candidate === expected) return true
  try {
    return candidate === realpathSync(expected)
  } catch {
    return false
  }
}

export interface MemoryWorkspace {
  readonly path: string
  attachSession(sessionId: SessionId): Promise<void>
}

export interface MemoryWorkspaceRegistry {
  create(path: string, title?: string): Promise<MemoryWorkspace>
}

export interface PreparedConsolidationWorkspace {
  readonly cwd: string
  attachSession(sessionId: SessionId): Promise<void>
}

export interface ConsolidationWorkspacePlacement {
  prepare(): Promise<PreparedConsolidationWorkspace>
}

/** Keep worker logs physically separate and attach them to a native DSH Workspace when available. */
export class DedicatedConsolidationWorkspace implements ConsolidationWorkspacePlacement {
  constructor(
    readonly directory: string,
    private readonly getRegistry: () => MemoryWorkspaceRegistry | undefined = () => undefined,
  ) {}

  async prepare(): Promise<PreparedConsolidationWorkspace> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const directory = realpathSync(this.directory)
    const registry = this.getRegistry()
    if (registry === undefined) {
      return { cwd: directory, attachSession: async () => undefined }
    }
    const workspace = await registry.create(directory, CONSOLIDATION_WORKSPACE_TITLE)
    if (workspace.path !== directory) {
      throw new Error(`consolidation Workspace resolved to an unexpected path: ${workspace.path}`)
    }
    return {
      cwd: workspace.path,
      attachSession: sessionId => workspace.attachSession(sessionId),
    }
  }
}
