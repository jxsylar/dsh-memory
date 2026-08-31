export type SessionId = string & { readonly __sessionId: unique symbol }

export function SessionId(value: string): SessionId {
  return value as SessionId
}

export function foldSurface(events: readonly unknown[]): { nodes: number[] } {
  const nodes: number[] = []
  for (const candidate of events) {
    const event = candidate as { seq: number; type: string; surfaceOp?: 'append' | { start: number; end: number } }
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    if (event.surfaceOp === 'append') nodes.push(event.seq)
    else if (event.surfaceOp !== undefined) {
      const start = nodes.indexOf(event.surfaceOp.start)
      const end = nodes.indexOf(event.surfaceOp.end)
      if (start < 0 || end < start) throw new Error('invalid surface replacement')
      nodes.splice(start, end - start + 1, event.seq)
    } else {
      throw new Error('surface event is missing surfaceOp')
    }
  }
  return { nodes }
}
