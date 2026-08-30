/** dsh-memory Browser Cordis entry. */

import { MemorySection, type MemoryApi } from './MemorySection.tsx'
import {
  parseGlobalMemoryView,
  parseGlobalReplaceResponse,
  parseMemoryStatus,
  type MemoryRpcResult,
} from '../protocol.ts'

interface BrowserConnection {
  readonly isLoopback: boolean
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<MemoryRpcResult<unknown>>
  }
}

interface BrowserSlots {
  inject(name: string, callback: () => () => void): void
  register(options: {
    name: string
    id: string
    order: number
    label: () => string
    inject: () => { api: MemoryApi; loopback: boolean }
  }, component: unknown): () => void
}

interface BrowserContext {
  readonly connection: BrowserConnection
  readonly slots: BrowserSlots
}

/** Browser services required by the Settings contribution. */
export const inject = ['slots', 'connection']

/** Register the independent Memory settings section. */
export function apply(ctx: BrowserContext): void {
  const api = createMemoryApi(ctx.connection)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 30,
    label: () => 'Memory',
    inject: () => ({ api, loopback: ctx.connection.isLoopback }),
  }, MemorySection))
}

function createMemoryApi(connection: BrowserConnection): MemoryApi {
  const call = async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const result = await connection.rpc.call('/memory', endpoint, payload, signal)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  return {
    status: async signal => parseMemoryStatus(await call('status', {}, signal)),
    readGlobal: async signal => parseGlobalMemoryView(await call('global/read', {}, signal)),
    replaceGlobal: async (input, signal) => parseGlobalReplaceResponse(await call('global/replace', input, signal)),
  }
}
