import { describe, expect, it, vi } from 'vitest'
import { adaptSessionPersistence } from '../src/session-persistence-adapter.ts'

function fixture() {
  const header = { id: 'source', createdAt: 42, cwd: '/project' }
  const events = [{ seq: 0, type: 'user/message' }]
  const handle = {
    header,
    read: vi.fn(async (_offset?: number, _length?: number, _options?: { signal?: AbortSignal }) => ({ events })),
    close: vi.fn(async () => {}),
  }
  const service = {
    snapshots: [{ header, revision: 'opaque:revision' }],
    async list(_options?: { signal?: AbortSignal }) { return this.snapshots },
    async open(_id: string, _access: 'read', _options?: { signal?: AbortSignal }) { return handle },
  }
  const list = vi.spyOn(service, 'list')
  const open = vi.spyOn(service, 'open')
  return { handle, service, list, open, persistence: adaptSessionPersistence(service) }
}

describe('DSH SessionPersistence adapter', () => {
  it('preserves legacy service methods and their receiver', async () => {
    const service = {
      header: { id: 'old', createdAt: 1 },
      async listSnapshots() { return [{ header: this.header, revision: 'old:1' }] },
      async inspect() { return { meta: this.header, events: [] } },
    }
    const persistence = adaptSessionPersistence(service)
    expect(persistence).toBe(service)
    expect(await persistence.listSnapshots()).toEqual([{ header: service.header, revision: 'old:1' }])
    expect(await persistence.inspect('old')).toEqual({ meta: service.header, events: [] })
  })

  it('preserves snapshots and reads the complete logical log with a read-only handle', async () => {
    const { persistence, service, list, open, handle } = fixture()
    const signal = new AbortController().signal
    const snapshots = await persistence.listSnapshots(signal)
    expect(list).toHaveBeenCalledWith({ signal })
    expect(snapshots).toEqual(service.snapshots)
    expect(snapshots).not.toBe(service.snapshots)
    expect(await persistence.inspect('source', signal)).toEqual({ meta: handle.header, events: [{ seq: 0, type: 'user/message' }] })
    expect(open).toHaveBeenCalledWith('source', 'read', { signal })
    expect(handle.read).toHaveBeenCalledWith(0, undefined, { signal })
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('closes the handle on read failure without masking the read error', async () => {
    const { persistence, handle } = fixture()
    const error = new Error('corrupt Session')
    handle.read.mockRejectedValueOnce(error)
    await expect(persistence.inspect('source')).rejects.toBe(error)
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it.each(['open', 'read'])('closes the handle when cancellation occurs during %s', async (stage) => {
    const { persistence, handle, open } = fixture()
    const controller = new AbortController()
    if (stage === 'open') open.mockImplementationOnce(async () => {
      controller.abort()
      return handle
    })
    else handle.read.mockImplementationOnce(async () => {
      controller.abort()
      return { events: [] }
    })
    await expect(persistence.inspect('source', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(handle.close).toHaveBeenCalledOnce()
    expect(handle.read).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1)
  })

  it('does not start backend work for an already cancelled request', async () => {
    const { persistence, list, open } = fixture()
    const signal = AbortSignal.abort()
    await expect(persistence.listSnapshots(signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(persistence.inspect('source', signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(list).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('propagates list and open failures without falling back to another API', async () => {
    const { persistence, list, open, handle } = fixture()
    const error = new Error('backend unavailable')
    list.mockRejectedValueOnce(error)
    open.mockRejectedValueOnce(error)
    await expect(persistence.listSnapshots()).rejects.toBe(error)
    await expect(persistence.inspect('source')).rejects.toBe(error)
    expect(handle.close).not.toHaveBeenCalled()
  })
})
