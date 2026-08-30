/** Minimal DSH Host service faces consumed by this out-of-tree plugin. */

import type { MemoryRpcResult } from './protocol.ts'

/** Current Agent identity made available to prompt and tool execution. */
export interface MemoryAgent {
  readonly session: { readonly header: { readonly cwd?: string } }
}

/** Prompt assembly context extended by dsh-agent. */
export interface MemoryAssembleContext {
  readonly agent?: MemoryAgent
}

/** Dynamic prompt registry used by dsh-memory. */
export interface MemorySystemPrompt {
  section(input: { name: string; order: number; text: string }): () => void
  context(input: { name: string; order: number; text: (context: MemoryAssembleContext) => string }): () => void
}

/** Tool execution context fields used to resolve the current Workspace. */
export interface MemoryToolExecution {
  readonly agent?: MemoryAgent
}

/** Tool registry used by the model-facing mutation Consumer. */
export interface MemoryToolRegistry {
  register(definition: unknown): () => void
}

/** Dedicated logical RPC registrar provided by dsh-client-connection. */
export interface MemoryHostConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<MemoryRpcResult<unknown>>,
      options: { authority: 'loopback' },
    ): () => Promise<void>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryStore: import('./memory-store.ts').MarkdownMemoryStore
    systemPrompt: MemorySystemPrompt
    tools: MemoryToolRegistry
    connection: MemoryHostConnection
  }
}
