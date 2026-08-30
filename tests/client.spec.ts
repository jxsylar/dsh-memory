import { describe, expect, it } from 'vitest'
import { apply, inject, type BrowserContext } from '../src/client/index.ts'
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
