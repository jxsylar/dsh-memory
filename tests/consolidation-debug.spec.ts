import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConsolidationDebugStore } from '../src/consolidation-debug.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ConsolidationDebugStore', () => {
  it('writes staged JSONL diagnostics and redacts credential-like values', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-debug-'))
    roots.push(root)
    const debug = new ConsolidationDebugStore(root, () => new Date('2026-08-31T00:00:00.000Z'))
    const identity = { reviewId: `review-${'a'.repeat(64)}`, attempt: 2 }
    debug.record(identity, 'worker-start', { provider: 'openai' })
    debug.failure(identity, 'agent-error', new Error('Authorization: Bearer sk-secret-value-123456'))
    const source = readFileSync(debug.pathFor(identity), 'utf8')
    const lines = source.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toMatchObject([{ stage: 'worker-start', provider: 'openai' }, { stage: 'agent-error' }])
    expect(source).not.toContain('sk-secret-value-123456')
    expect(source).toContain('[REDACTED]')
  })

  it('does not create a log when diagnostics are disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-memory-debug-'))
    roots.push(root)
    const debug = new ConsolidationDebugStore(root, () => new Date(), () => undefined, () => false)
    const identity = { reviewId: `review-${'b'.repeat(64)}`, attempt: 1 }
    debug.record(identity, 'worker-start')
    expect(existsSync(debug.pathFor(identity))).toBe(false)
  })
})
