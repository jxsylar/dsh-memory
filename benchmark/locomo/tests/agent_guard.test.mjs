import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../agent-guard/index.mjs'

const previousMode = process.env.DSH_LOCOMO_AGENT_MODE
const previousHome = process.env.DSH_HOME

afterEach(() => {
  if (previousMode === undefined) delete process.env.DSH_LOCOMO_AGENT_MODE
  else process.env.DSH_LOCOMO_AGENT_MODE = previousMode
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

function mount(mode) {
  process.env.DSH_LOCOMO_AGENT_MODE = mode
  process.env.DSH_HOME = '/isolated/dsh-home'
  let start
  let preStep
  let guard
  let restriction
  let section
  const agent = {
    session: { header: { cwd: '/isolated/workspace' } },
    ctx: {
      tools: {
        guard(value) { guard = value },
        restrict(value) { restriction = value },
      },
      systemPrompt: { section(value) { section = value } },
      on(event, listener) {
        if (event === 'agent/pre-step') preStep = listener
      },
    },
  }
  apply({ on(event, listener) { if (event === 'agent/session-start') start = listener } })
  start({ agent })
  return { guard, restriction, section, preStep }
}

describe('LoCoMo Agent guard', () => {
  it('gives baseline no tools or memory-seeking instructions', async () => {
    const mounted = mount('baseline')
    expect(mounted.restriction).toEqual({ allow: [] })
    expect(mounted.section).toMatchObject({ complete: true })
    expect(mounted.section.text).toContain('without conversation history or long-term memory')
    expect(mounted.section.text).toContain('Do not use tools')
    expect(mounted.guard({ name: 'read', arguments: {} })).toMatch(/cannot use read/)
    await expect(mounted.preStep({ step: 1 }, async () => ({ kind: 'enter' })))
      .resolves.toEqual({ kind: 'enter' })
    await expect(mounted.preStep({ step: 2 }, async () => ({ kind: 'enter' })))
      .resolves.toEqual({ kind: 'reject' })
  })

  it('limits ingestion to memory reads and writes with a six-step ceiling', async () => {
    const mounted = mount('ingest')
    expect(mounted.restriction).toEqual({ allow: ['read', 'memory_update'] })
    expect(mounted.section).toMatchObject({ complete: true })
    expect(mounted.guard({ name: 'bash', arguments: {} })).toMatch(/cannot use bash/)
    expect(mounted.guard({
      name: 'read',
      arguments: { file_path: '/isolated/dsh-home/memory/workspaces/a/fact.md' },
    })).toBeUndefined()
    expect(mounted.guard({
      name: 'read',
      arguments: { file_path: '/repo/benchmark/locomo10.json' },
    })).toMatch(/only files under the isolated memory root/)
    await expect(mounted.preStep({ step: 6 }, async () => ({ kind: 'enter' })))
      .resolves.toEqual({ kind: 'enter' })
    await expect(mounted.preStep({ step: 7 }, async () => ({ kind: 'enter' })))
      .resolves.toEqual({ kind: 'reject' })
  })

  it('does not expose memory mutation during QA', () => {
    const mounted = mount('qa')
    expect(mounted.restriction).toEqual({ allow: ['read'] })
    expect(mounted.guard({ name: 'memory_update', arguments: {} }))
      .toMatch(/cannot use memory_update/)
  })
})
