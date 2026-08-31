import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConsolidationSettingsStore,
  readConsolidationModelCatalog,
  selectionIsAvailable,
} from '../src/consolidation-settings.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(): { root: string; store: ConsolidationSettingsStore } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-settings-'))
  roots.push(root)
  return { root, store: new ConsolidationSettingsStore(root, { provider: 'default', model: 'cheap' }) }
}

describe('ConsolidationSettingsStore', () => {
  it('persists one CAS-checked model selection without credentials', () => {
    const { store } = setup()
    const initial = store.read()
    expect(initial.selection).toEqual({ provider: 'default', model: 'cheap' })
    const committed = store.commit({
      expectedRevision: initial.revision,
      selection: { provider: 'openai', model: 'gpt-small' },
    })
    expect(committed.status).toBe('committed')
    expect(store.read().selection).toEqual({ provider: 'openai', model: 'gpt-small' })
    expect(store.commit({
      expectedRevision: initial.revision,
      selection: { provider: 'other', model: 'other' },
    })).toMatchObject({ status: 'conflict' })
  })

  it('rejects malformed settings files', () => {
    const { root, store } = setup()
    writeFileSync(join(root, 'settings.yml'), 'format: 1\nprovider: ok\nmodel: ok\nsecret: no\n')
    expect(() => store.read()).toThrow(/unknown fields/)
  })

  it('projects active text models and isolates one provider catalog failure', async () => {
    const { store } = setup()
    const catalog = await readConsolidationModelCatalog({
      listProviders: () => [{ id: 'active', name: 'Active' }, { id: 'broken', name: 'Broken' }],
      async listModels(provider) {
        if (provider === 'broken') throw new Error('catalog offline')
        return [
          { provider, id: 'text', name: 'Text', inputModalities: ['text'] },
          { provider, id: 'image', name: 'Image', inputModalities: ['image'] },
        ]
      },
    }, store)
    expect(catalog.providers).toEqual([{ id: 'active', name: 'Active', models: [{ id: 'text', name: 'Text' }] }])
    expect(catalog.failures).toEqual([{ provider: 'broken', message: 'catalog offline' }])
    expect(selectionIsAvailable(catalog, { provider: 'active', model: 'text' })).toBe(true)
    expect(selectionIsAvailable(catalog, { provider: 'active', model: 'image' })).toBe(false)
  })
})
