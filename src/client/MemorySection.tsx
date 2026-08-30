/** Settings section for Memory status and the first Global management slice. */

import { useCallback, useEffect, useState } from 'react'
import type {
  GlobalMemoryView,
  GlobalReplaceResponse,
  MemoryRevision,
  MemoryStatus,
} from '../protocol.ts'
import type { MemoryTranslate } from './locales.ts'

/** Host operations used by the Settings component. */
export interface MemoryApi {
  status(signal?: AbortSignal): Promise<MemoryStatus>
  readGlobal(signal?: AbortSignal): Promise<GlobalMemoryView>
  replaceGlobal(input: { expectedRevision: MemoryRevision; content: string }, signal?: AbortSignal): Promise<GlobalReplaceResponse>
}

/** Settings slot injection assembled by the Browser Cordis entry. */
export interface MemorySectionInjected {
  readonly api: MemoryApi
  readonly loopback: boolean
  readonly t: MemoryTranslate
}

type Tab = 'global' | 'workspaces' | 'sessions'
type ErrorState =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'message'; readonly value: string }

/** Render status plus Global, Workspaces, and Sessions tabs. */
export function MemorySection(props: MemorySectionInjected): React.JSX.Element {
  const { t } = props
  const [tab, setTab] = useState<Tab>('global')
  const [status, setStatus] = useState<MemoryStatus>()
  const [global, setGlobal] = useState<GlobalMemoryView>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorState>()

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!props.loopback) return
    setBusy(true)
    setError(undefined)
    try {
      const [nextStatus, nextGlobal] = await Promise.all([
        props.api.status(signal),
        props.api.readGlobal(signal),
      ])
      setStatus(nextStatus)
      setGlobal(nextGlobal)
      setDraft(nextGlobal.content)
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }, [props.api, props.loopback])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [refresh])

  const save = async (): Promise<void> => {
    if (global === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await props.api.replaceGlobal({ expectedRevision: global.revision, content: draft })
      if (result.status === 'conflict') {
        setError({ kind: 'conflict' })
        return
      }
      await refresh()
    } catch (cause: unknown) {
      setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  if (!props.loopback) {
    return <section style={memorySectionStyles.page}><h2>{t('title')}</h2><p>{t('loopbackOnly')}</p></section>
  }

  return (
    <section style={memorySectionStyles.page}>
      <header style={memorySectionStyles.header}>
        <div style={memorySectionStyles.heading}>
          <h2 style={memorySectionStyles.title}>{t('title')}</h2>
          <p style={memorySectionStyles.subtitle}>{t('subtitle')}</p>
        </div>
        <button type="button" style={memorySectionStyles.button} disabled={busy} onClick={() => { void refresh() }}>{t('refresh')}</button>
      </header>

      <div style={memorySectionStyles.status}>
        <span><strong>{t('status')}</strong> {status === undefined ? t('loading') : t('enabled')}</span>
        <span><strong>{t('global')}</strong> {t('bytes', { count: status?.globalBytes ?? 0 })}</span>
        <span><strong>{t('workspaces')}</strong> {status?.workspaceCount ?? 0}</span>
        <span style={memorySectionStyles.path}><strong>{t('root')}</strong> {status?.root ?? '—'}</span>
      </div>

      <nav style={memorySectionStyles.tabs} aria-label={t('sections')}>
        {(['global', 'workspaces', 'sessions'] as const).map(id => (
          <button
            key={id}
            type="button"
            style={{ ...memorySectionStyles.tab, ...(tab === id ? memorySectionStyles.activeTab : {}) }}
            onClick={() => { setTab(id) }}
          >
            {t(`${id}Tab`)}
          </button>
        ))}
      </nav>

      {error === undefined ? null : (
        <p role="alert" style={memorySectionStyles.error}>
          {error.kind === 'conflict' ? t('conflict') : error.value}
        </p>
      )}

      {tab === 'global' ? (
        <div style={memorySectionStyles.panel}>
          <label htmlFor="dsh-memory-global"><strong>GLOBAL.md</strong></label>
          <textarea
            id="dsh-memory-global"
            style={memorySectionStyles.editor}
            spellCheck={false}
            value={draft}
            onChange={event => { setDraft(event.target.value) }}
          />
          <div style={memorySectionStyles.actions}>
            <button type="button" style={memorySectionStyles.primaryButton} disabled={busy || global === undefined} onClick={() => { void save() }}>
              {t('saveGlobal')}
            </button>
          </div>
        </div>
      ) : (
        <div style={memorySectionStyles.placeholder}>
          <strong>{tab === 'workspaces' ? t('workspacePlaceholder') : t('sessionPlaceholder')}</strong>
          <p>{t('placeholderBody')}</p>
        </div>
      )}
    </section>
  )
}

export const memorySectionStyles: Record<string, React.CSSProperties> = {
  page: { display: 'grid', gap: 16, padding: 24, color: 'inherit', boxSizing: 'border-box', width: '100%', maxWidth: '100%', minWidth: 0 },
  header: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 16, alignItems: 'center', minWidth: 0 },
  heading: { flex: '1 1 240px', minWidth: 0 },
  title: { margin: 0, fontSize: 24 },
  subtitle: { margin: '4px 0 0', opacity: 0.72 },
  button: { padding: '8px 12px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit' },
  primaryButton: { padding: '9px 14px', borderRadius: 8, border: 0, background: '#5b5bd6', color: '#fff', fontWeight: 600 },
  status: { display: 'flex', flexWrap: 'wrap', gap: '8px 20px', padding: 14, borderRadius: 10, background: 'rgba(127,127,127,0.12)', boxSizing: 'border-box', width: '100%', maxWidth: '100%', minWidth: 0 },
  path: { flexBasis: '100%', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 8, borderBottom: '1px solid rgba(127,127,127,0.3)', maxWidth: '100%', minWidth: 0 },
  tab: { padding: '9px 12px', border: 0, borderBottom: '2px solid transparent', background: 'transparent', color: 'inherit', opacity: 0.7 },
  activeTab: { borderBottom: '2px solid #5b5bd6', opacity: 1, fontWeight: 600 },
  panel: { display: 'grid', gap: 10, width: '100%', maxWidth: '100%', minWidth: 0 },
  editor: { display: 'block', minHeight: 320, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', resize: 'vertical', borderRadius: 10, padding: 14, border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.06)', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5 },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12, alignItems: 'center', minWidth: 0 },
  error: { margin: 0, padding: 12, borderRadius: 8, background: 'rgba(200,40,40,0.15)', color: '#d44', overflowWrap: 'anywhere' },
  placeholder: { padding: 24, border: '1px dashed rgba(127,127,127,0.45)', borderRadius: 10, opacity: 0.75, boxSizing: 'border-box', maxWidth: '100%', minWidth: 0 },
}
