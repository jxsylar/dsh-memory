/** Settings section for Memory status and the first Global management slice. */

import { useCallback, useEffect, useState } from 'react'
import type {
  GlobalMemoryView,
  GlobalReplaceResponse,
  MemoryRevision,
  MemoryStatus,
} from '../protocol.ts'

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
}

type Tab = 'global' | 'workspaces' | 'sessions'

/** Render status plus Global, Workspaces, and Sessions tabs. */
export function MemorySection(props: MemorySectionInjected): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('global')
  const [status, setStatus] = useState<MemoryStatus>()
  const [global, setGlobal] = useState<GlobalMemoryView>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

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
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause))
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
        setError('GLOBAL.md changed since this page loaded. Refresh before saving again.')
        return
      }
      await refresh()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!props.loopback) {
    return <section style={styles.page}><h2>Memory</h2><p>This page is available only from the loopback Web host.</p></section>
  }

  return (
    <section style={styles.page}>
      <header style={styles.header}>
        <div>
          <h2 style={styles.title}>Memory</h2>
          <p style={styles.subtitle}>Local Markdown memory managed by the Host.</p>
        </div>
        <button type="button" style={styles.button} disabled={busy} onClick={() => { void refresh() }}>Refresh</button>
      </header>

      <div style={styles.status}>
        <span><strong>Status:</strong> {status === undefined ? 'Loading…' : 'Enabled'}</span>
        <span><strong>Global:</strong> {status?.globalBytes ?? 0} bytes</span>
        <span><strong>Workspaces:</strong> {status?.workspaceCount ?? 0}</span>
        <span style={styles.path}><strong>Root:</strong> {status?.root ?? '—'}</span>
      </div>

      <nav style={styles.tabs} aria-label="Memory sections">
        {(['global', 'workspaces', 'sessions'] as const).map(id => (
          <button
            key={id}
            type="button"
            style={{ ...styles.tab, ...(tab === id ? styles.activeTab : {}) }}
            onClick={() => { setTab(id) }}
          >
            {id[0]!.toUpperCase()}{id.slice(1)}
          </button>
        ))}
      </nav>

      {error === undefined ? null : <p role="alert" style={styles.error}>{error}</p>}

      {tab === 'global' ? (
        <div style={styles.panel}>
          <label htmlFor="dsh-memory-global"><strong>GLOBAL.md</strong></label>
          <textarea
            id="dsh-memory-global"
            style={styles.editor}
            spellCheck={false}
            value={draft}
            onChange={event => { setDraft(event.target.value) }}
          />
          <div style={styles.actions}>
            <code style={styles.revision}>{global?.revision ?? '—'}</code>
            <button type="button" style={styles.primaryButton} disabled={busy || global === undefined} onClick={() => { void save() }}>
              Save Global Memory
            </button>
          </div>
        </div>
      ) : (
        <div style={styles.placeholder}>
          <strong>{tab === 'workspaces' ? 'Workspace memory management' : 'Session consolidation'}</strong>
          <p>This surface is reserved by the architecture and will be connected in the next implementation milestone.</p>
        </div>
      )}
    </section>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'grid', gap: 16, padding: 24, color: 'inherit' },
  header: { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' },
  title: { margin: 0, fontSize: 24 },
  subtitle: { margin: '4px 0 0', opacity: 0.72 },
  button: { padding: '8px 12px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit' },
  primaryButton: { padding: '9px 14px', borderRadius: 8, border: 0, background: '#5b5bd6', color: '#fff', fontWeight: 600 },
  status: { display: 'flex', flexWrap: 'wrap', gap: '8px 20px', padding: 14, borderRadius: 10, background: 'rgba(127,127,127,0.12)' },
  path: { flexBasis: '100%', overflowWrap: 'anywhere' },
  tabs: { display: 'flex', gap: 8, borderBottom: '1px solid rgba(127,127,127,0.3)' },
  tab: { padding: '9px 12px', border: 0, borderBottom: '2px solid transparent', background: 'transparent', color: 'inherit', opacity: 0.7 },
  activeTab: { borderBottomColor: '#5b5bd6', opacity: 1, fontWeight: 600 },
  panel: { display: 'grid', gap: 10 },
  editor: { minHeight: 320, width: '100%', boxSizing: 'border-box', resize: 'vertical', borderRadius: 10, padding: 14, border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.06)', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5 },
  actions: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
  revision: { overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.65 },
  error: { margin: 0, padding: 12, borderRadius: 8, background: 'rgba(200,40,40,0.15)', color: '#d44' },
  placeholder: { padding: 24, border: '1px dashed rgba(127,127,127,0.45)', borderRadius: 10, opacity: 0.75 },
}
