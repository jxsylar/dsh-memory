/** Normalize DSH persistence APIs without taking Session write ownership. */
import type { MemoryHandleSessionPersistence, MemorySessionPersistence } from './host-contracts.ts'

export function adaptSessionPersistence(
  persistence: MemorySessionPersistence | MemoryHandleSessionPersistence,
): MemorySessionPersistence {
  if ('list' in persistence && typeof persistence.list === 'function'
    && 'open' in persistence && typeof persistence.open === 'function') {
    return {
      async listSnapshots(signal) {
        signal?.throwIfAborted()
        const snapshots = await persistence.list(signal === undefined ? {} : { signal })
        signal?.throwIfAborted()
        return [...snapshots]
      },
      async inspect(id, signal) {
        signal?.throwIfAborted()
        const options = signal === undefined ? {} : { signal }
        const handle = await persistence.open(id, 'read', options)
        try {
          signal?.throwIfAborted()
          const { events } = await handle.read(0, undefined, options)
          signal?.throwIfAborted()
          return { meta: handle.header, events }
        } finally {
          await handle.close()
        }
      },
    }
  }
  if ('listSnapshots' in persistence && typeof persistence.listSnapshots === 'function'
    && 'inspect' in persistence && typeof persistence.inspect === 'function') {
    return persistence
  }
  throw new Error('Unsupported DSH SessionPersistence: expected list/open or listSnapshots/inspect')
}
