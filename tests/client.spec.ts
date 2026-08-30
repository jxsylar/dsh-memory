import { describe, expect, it } from 'vitest'
import { apply, inject, type BrowserContext } from '../src/client/index.ts'
import { memorySectionStyles } from '../src/client/MemorySection.tsx'
import { en, zh } from '../src/client/locales.ts'

describe('Browser locale integration', () => {
  it('registers balanced dictionaries and follows the active DSH locale', () => {
    let active: 'zh' | 'en' = 'en'
    let registered: { readonly zh: Readonly<Record<string, string>>; readonly en: Readonly<Record<string, string>> } | undefined
    let registration: Parameters<BrowserContext['slots']['register']>[0] | undefined

    const ctx: BrowserContext = {
      connection: {
        isLoopback: true,
        rpc: {
          call: async () => { throw new Error('RPC is not used by this test') },
        },
      },
      locale: {
        register(_namespace, dictionaries) {
          registered = dictionaries
          return () => undefined
        },
        bind() {
          return (key, params) => {
            const template = (active === 'zh' ? zh : en)[key]
            return template.replace(/\{(\w+)\}/g, (match, name: string) =>
              params !== undefined && name in params ? String(params[name]) : match)
          }
        },
      },
      slots: {
        inject(_name, callback) { callback() },
        register(options) {
          registration = options
          return () => undefined
        },
      },
      effect(callback) { callback() },
    }

    apply(ctx)

    expect(inject).toContain('locale')
    expect(Object.keys(registered?.en ?? {})).toEqual(Object.keys(registered?.zh ?? {}))
    expect(registration?.locale).toBe('settings.memory')
    expect(registration?.label()).toBe('Memory')
    active = 'zh'
    expect(registration?.label()).toBe('记忆')
    expect(ctx.locale.bind('settings.memory')('bytes', { count: 12 })).toBe('12 字节')
  })
})

describe('Memory section responsive layout', () => {
  it('keeps wide content inside the Settings section and allows controls to wrap', () => {
    expect(memorySectionStyles.page).toMatchObject({
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '100%',
      minWidth: 0,
    })
    expect(memorySectionStyles.header).toMatchObject({ flexWrap: 'wrap', minWidth: 0 })
    expect(memorySectionStyles.status).toMatchObject({ maxWidth: '100%', minWidth: 0 })
    expect(memorySectionStyles.path).toMatchObject({ overflowWrap: 'anywhere', minWidth: 0 })
    expect(memorySectionStyles.tabs).toMatchObject({ flexWrap: 'wrap', maxWidth: '100%', minWidth: 0 })
    expect(memorySectionStyles.editor).toMatchObject({ width: '100%', maxWidth: '100%', minWidth: 0 })
    expect(memorySectionStyles.actions).toMatchObject({ flexWrap: 'wrap', justifyContent: 'flex-end' })
  })
})

describe('Memory section tab selection', () => {
  it('uses the same border property for active and inactive tabs', () => {
    expect(memorySectionStyles.tab).toMatchObject({ borderBottom: '2px solid transparent' })
    expect(memorySectionStyles.activeTab).toMatchObject({ borderBottom: '2px solid #5b5bd6' })
    expect(memorySectionStyles.activeTab).not.toHaveProperty('borderBottomColor')
  })
})
