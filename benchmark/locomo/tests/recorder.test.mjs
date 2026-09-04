import { describe, expect, it } from 'vitest'

import { collectSessionMetrics } from '../recorder/index.mjs'

describe('LoCoMo consolidation recorder', () => {
  it('reports the final turn reason with usage and elapsed time', () => {
    expect(collectSessionMetrics('worker-1', [
      { type: 'turn/start', time: 100, data: { turn: 1 } },
      {
        type: 'assistant/chunk',
        time: 150,
        data: { chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 8192 } } },
      },
      { type: 'turn/end', time: 300, data: { reason: { kind: 'max-tokens' } } },
    ])).toEqual({
      sessionId: 'worker-1',
      modelCalls: 1,
      usage: [{ inputTokens: 20, outputTokens: 8192 }],
      finishReason: 'max-tokens',
      workerElapsedMs: 200,
    })
  })
})
