let nextMessageId = 0

export function createUserMessage(input: {
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'plugin'; plugin: string }
}): unknown {
  nextMessageId += 1
  return { id: `message-${nextMessageId}`, role: 'user', ...input }
}
