import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index.ts'

const roots: string[] = []
const previousDshHome = process.env.DSH_HOME

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
})

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-'))
  roots.push(root)
  process.env.DSH_HOME = root
  return root
}

describe('Host Cordis composition', () => {
  it('loads in Headless without Web-only services', async () => {
    isolatedHome()
    const ctx = new Context()
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    expect(ctx.get('memoryStore')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('memoryStore')).toBeUndefined()
  })

  it('registers prompt, tool, and loopback RPC Consumers when their services exist', async () => {
    isolatedHome()
    const ctx = new Context()
    const sections: unknown[] = []
    const contexts: unknown[] = []
    const tools: unknown[] = []
    const channels: unknown[] = []
    ctx.provide('systemPrompt', {
      section(value: unknown) { sections.push(value); return () => undefined },
      context(value: unknown) { contexts.push(value); return () => undefined },
    })
    ctx.provide('tools', {
      register(value: unknown) { tools.push(value); return () => undefined },
    })
    ctx.provide('connection', {
      rpc: {
        handle(channel: string, handler: unknown, options: unknown) {
          channels.push({ channel, handler, options })
          return async () => undefined
        },
      },
    })
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    expect(sections).toHaveLength(1)
    expect(contexts).toHaveLength(1)
    expect(tools).toMatchObject([{ name: 'memory_update' }])
    expect(channels).toMatchObject([{ channel: '/memory', options: { authority: 'loopback' } }])
    await fiber.dispose()
  })
})
