/** Settings section for Memory status and the first Global management slice. */

import { useCallback, useEffect, useState } from 'react'
import type {
  GlobalMemoryView,
  GlobalReplaceResponse,
  MemoryRevision,
  MemoryStatus,
  SessionIneligibleReason,
  SessionListResponse,
  WorkspaceId,
  WorkspaceCommitChange,
  WorkspaceCommitPayload,
  WorkspaceCommitResponse,
  WorkspaceListResponse,
  WorkspaceRecordView,
  WorkspaceReadResponse,
} from '../protocol.ts'
import type { MemoryLocaleKey, MemoryTranslate } from './locales.ts'

/** Host operations used by the Settings component. */
export interface MemoryApi {
  status(signal?: AbortSignal): Promise<MemoryStatus>
  readGlobal(signal?: AbortSignal): Promise<GlobalMemoryView>
  replaceGlobal(input: { expectedRevision: MemoryRevision; content: string }, signal?: AbortSignal): Promise<GlobalReplaceResponse>
  listWorkspaces(signal?: AbortSignal): Promise<WorkspaceListResponse>
  readWorkspace(workspaceId: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceReadResponse>
  commitWorkspace(input: WorkspaceCommitPayload, signal?: AbortSignal): Promise<WorkspaceCommitResponse>
  listSessions(signal?: AbortSignal): Promise<SessionListResponse>
}

/** Settings slot injection assembled by the Browser Cordis entry. */
export interface MemorySectionInjected {
  readonly api: MemoryApi
  readonly loopback: boolean
  readonly t: MemoryTranslate
}

type Tab = 'global' | 'workspaces' | 'sessions'
type MemoryButtonVariant = 'default' | 'primary' | 'danger' | 'tab' | 'workspace'
type ErrorState =
  | { readonly kind: 'global-conflict' }
  | { readonly kind: 'workspace-conflict' }
  | { readonly kind: 'message'; readonly value: string }

export interface WorkspaceDraftRecord extends WorkspaceRecordView {
  readonly draftId: string
  readonly originalName?: string
}

export type WorkspaceDraftIssue = 'name' | 'duplicate-name' | 'description' | 'content'

let workspaceDraftSequence = 0

interface MemoryButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: MemoryButtonVariant
}

/** Button wrapper that keeps hover/press feedback in inline styles. */
function MemoryButton({
  variant = 'default',
  style,
  disabled,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onBlur,
  ...props
}: MemoryButtonProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  return (
    <button
      {...props}
      disabled={disabled}
      style={{
        ...style,
        ...(hovered && !disabled ? memoryButtonHoverStyles[variant] : {}),
        ...(pressed && !disabled ? memoryButtonPressedStyle : {}),
        ...(disabled ? memoryButtonDisabledStyle : {}),
      }}
      onPointerEnter={(event) => { setHovered(true); onPointerEnter?.(event) }}
      onPointerLeave={(event) => { setHovered(false); setPressed(false); onPointerLeave?.(event) }}
      onPointerDown={(event) => { setPressed(true); onPointerDown?.(event) }}
      onPointerUp={(event) => { setPressed(false); onPointerUp?.(event) }}
      onPointerCancel={(event) => { setPressed(false); onPointerCancel?.(event) }}
      onBlur={(event) => { setHovered(false); setPressed(false); onBlur?.(event) }}
    />
  )
}

function draftsFrom(records: readonly WorkspaceRecordView[]): WorkspaceDraftRecord[] {
  return records.map(record => ({ ...record, draftId: `existing:${record.name}`, originalName: record.name }))
}

/** Build one deterministic delete-then-put batch from the editable Workspace draft. */
export function buildWorkspaceChanges(
  original: readonly WorkspaceRecordView[],
  drafts: readonly WorkspaceDraftRecord[],
): WorkspaceCommitChange[] {
  const originalByName = new Map(original.map(record => [record.name, record]))
  const retainedNames = new Set(drafts
    .filter(draft => draft.originalName !== undefined && draft.originalName === draft.name)
    .map(draft => draft.originalName as string))
  const deletes: WorkspaceCommitChange[] = original
    .filter(record => !retainedNames.has(record.name))
    .map(record => ({ action: 'delete' as const, name: record.name }))
    .sort((left, right) => left.action === 'delete' && right.action === 'delete'
      ? left.name.localeCompare(right.name, 'en')
      : 0)
  const puts: WorkspaceCommitChange[] = drafts
    .filter((draft) => {
      const previous = draft.originalName === undefined ? undefined : originalByName.get(draft.originalName)
      return previous === undefined
        || previous.name !== draft.name
        || previous.description !== draft.description
        || previous.type !== draft.type
        || previous.content !== draft.content
    })
    .map(({ name, description, type, content }) => ({
      action: 'put' as const,
      record: { name, description, type, content },
    }))
    .sort((left, right) => left.action === 'put' && right.action === 'put'
      ? left.record.name.localeCompare(right.record.name, 'en')
      : 0)
  return [...deletes, ...puts]
}

/** Return the first client-side issue that prevents a valid Workspace batch. */
export function workspaceDraftIssue(drafts: readonly WorkspaceDraftRecord[]): WorkspaceDraftIssue | undefined {
  const names = new Set<string>()
  for (const draft of drafts) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(draft.name)) return 'name'
    if (names.has(draft.name)) return 'duplicate-name'
    names.add(draft.name)
    if (draft.description.trim() === '' || /[\r\n]/u.test(draft.description)) return 'description'
    if (draft.content.trim() === '') return 'content'
  }
}

/** Render status plus Global, Workspaces, and Sessions tabs. */
export function MemorySection(props: MemorySectionInjected): React.JSX.Element {
  const { t } = props
  const [tab, setTab] = useState<Tab>('global')
  const [status, setStatus] = useState<MemoryStatus>()
  const [global, setGlobal] = useState<GlobalMemoryView>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceListResponse['workspaces']>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId>()
  const [workspace, setWorkspace] = useState<WorkspaceReadResponse>()
  const [workspaceDrafts, setWorkspaceDrafts] = useState<WorkspaceDraftRecord[]>([])
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessions, setSessions] = useState<SessionListResponse>()
  const [error, setError] = useState<ErrorState>()
  const workspaceChanges = workspace === undefined ? [] : buildWorkspaceChanges(workspace.records, workspaceDrafts)
  const workspaceDirty = workspaceChanges.length > 0
  const draftIssue = workspaceDraftIssue(workspaceDrafts)

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
        setError({ kind: 'global-conflict' })
        return
      }
      await refresh()
    } catch (cause: unknown) {
      setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  const readWorkspace = async (workspaceId: WorkspaceId, signal?: AbortSignal): Promise<void> => {
    setSelectedWorkspaceId(workspaceId)
    setWorkspace(undefined)
    setWorkspaceBusy(true)
    setError(undefined)
    try {
      const next = await props.api.readWorkspace(workspaceId, signal)
      setWorkspace(next)
      setWorkspaceDrafts(draftsFrom(next.records))
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setWorkspaceBusy(false)
    }
  }

  const refreshWorkspaces = async (signal?: AbortSignal): Promise<void> => {
    setWorkspaceBusy(true)
    setError(undefined)
    try {
      const result = await props.api.listWorkspaces(signal)
      setWorkspaces(result.workspaces)
      const target = result.workspaces.find(entry => entry.workspaceId === selectedWorkspaceId)
        ?? result.workspaces[0]
      if (target === undefined) {
        setSelectedWorkspaceId(undefined)
        setWorkspace(undefined)
        setWorkspaceDrafts([])
      } else {
        setSelectedWorkspaceId(target.workspaceId)
        setWorkspace(undefined)
        setWorkspaceDrafts([])
        const next = await props.api.readWorkspace(target.workspaceId, signal)
        setWorkspace(next)
        setWorkspaceDrafts(draftsFrom(next.records))
      }
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setWorkspaceBusy(false)
    }
  }

  const refreshSessions = async (signal?: AbortSignal): Promise<void> => {
    setSessionBusy(true)
    setError(undefined)
    try {
      setSessions(await props.api.listSessions(signal))
    } catch (cause: unknown) {
      if (!signal?.aborted) setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (!signal?.aborted) setSessionBusy(false)
    }
  }

  const changeTab = (next: Tab): void => {
    setTab(next)
    setError(undefined)
    if (next === 'workspaces' && tab !== 'workspaces' && workspaces.length === 0) void refreshWorkspaces()
    if (next === 'sessions' && tab !== 'sessions' && sessions === undefined) void refreshSessions()
  }

  const refreshVisible = async (): Promise<void> => {
    await refresh()
    if (tab === 'workspaces') await refreshWorkspaces()
    if (tab === 'sessions') await refreshSessions()
  }

  const updateWorkspaceDraft = (
    draftId: string,
    update: Partial<Pick<WorkspaceDraftRecord, 'name' | 'description' | 'type' | 'content'>>,
  ): void => {
    setWorkspaceDrafts(current => current.map(record => record.draftId === draftId ? { ...record, ...update } : record))
  }

  const addWorkspaceRecord = (): void => {
    const names = new Set(workspaceDrafts.map(record => record.name))
    let suffix = 1
    let name = 'new-memory'
    while (names.has(name)) {
      suffix += 1
      name = `new-memory-${suffix}`
    }
    workspaceDraftSequence += 1
    setWorkspaceDrafts(current => [...current, {
      draftId: `new:${workspaceDraftSequence}`,
      name,
      description: '',
      type: 'project',
      content: '',
    }])
  }

  const discardWorkspaceChanges = (): void => {
    if (workspace === undefined) return
    setWorkspaceDrafts(draftsFrom(workspace.records))
    setError(undefined)
  }

  const saveWorkspace = async (): Promise<void> => {
    if (workspace === undefined || workspaceChanges.length === 0 || draftIssue !== undefined) return
    setWorkspaceBusy(true)
    setError(undefined)
    try {
      const result = await props.api.commitWorkspace({
        workspaceId: workspace.workspaceId,
        expectedRevision: workspace.revision,
        changes: workspaceChanges,
      })
      if (result.status === 'conflict') {
        setError({ kind: 'workspace-conflict' })
        return
      }
      await refreshWorkspaces()
    } catch (cause: unknown) {
      setError({ kind: 'message', value: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setWorkspaceBusy(false)
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
        <MemoryButton
          type="button"
          style={memorySectionStyles.button}
          disabled={busy || workspaceBusy || sessionBusy || (tab === 'workspaces' && workspaceDirty)}
          onClick={() => { void refreshVisible() }}
        >
          {t('refresh')}
        </MemoryButton>
      </header>

      <div style={memorySectionStyles.status}>
        <span><strong>{t('status')}</strong> {status === undefined ? t('loading') : t('enabled')}</span>
        <span><strong>{t('global')}</strong> {t('bytes', { count: status?.globalBytes ?? 0 })}</span>
        <span><strong>{t('workspaces')}</strong> {status?.workspaceCount ?? 0}</span>
        <span style={memorySectionStyles.path}><strong>{t('root')}</strong> {status?.root ?? '—'}</span>
      </div>

      <nav style={memorySectionStyles.tabs} aria-label={t('sections')}>
        {(['global', 'workspaces', 'sessions'] as const).map(id => (
          <MemoryButton
            key={id}
            type="button"
            variant="tab"
            style={{ ...memorySectionStyles.tab, ...(tab === id ? memorySectionStyles.activeTab : {}) }}
            onClick={() => { changeTab(id) }}
          >
            {t(`${id}Tab`)}
          </MemoryButton>
        ))}
      </nav>

      {error === undefined ? null : (
        <p role="alert" style={memorySectionStyles.error}>
          {error.kind === 'global-conflict'
            ? t('conflict')
            : error.kind === 'workspace-conflict'
              ? t('workspaceConflict')
              : error.value}
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
            <MemoryButton variant="primary" type="button" style={memorySectionStyles.primaryButton} disabled={busy || global === undefined} onClick={() => { void save() }}>
              {t('saveGlobal')}
            </MemoryButton>
          </div>
        </div>
      ) : tab === 'workspaces' ? (
        <div style={memorySectionStyles.workspaceLayout}>
          <aside style={memorySectionStyles.workspaceList} aria-label={t('workspaceList')}>
            <strong>{t('workspaceList')}</strong>
            {workspaceBusy && workspaces.length === 0 ? <p>{t('loading')}</p> : null}
            {!workspaceBusy && workspaces.length === 0 ? <p style={memorySectionStyles.muted}>{t('workspaceEmpty')}</p> : null}
            {workspaces.map(entry => (
              <MemoryButton
                key={entry.workspaceId}
                type="button"
                variant="workspace"
                style={{
                  ...memorySectionStyles.workspaceButton,
                  ...(selectedWorkspaceId === entry.workspaceId ? memorySectionStyles.activeWorkspaceButton : {}),
                }}
                disabled={workspaceBusy || workspaceDirty}
                onClick={() => { void readWorkspace(entry.workspaceId) }}
              >
                <span>{entry.displayName}</span>
                <small style={memorySectionStyles.muted}>{t('recordCount', { count: entry.recordCount })}</small>
              </MemoryButton>
            ))}
          </aside>

          <div style={memorySectionStyles.workspaceDetail}>
            {workspace === undefined ? null : (
              <>
                <header style={memorySectionStyles.workspaceHeading}>
                  <h3 style={memorySectionStyles.workspaceTitle}>{workspace.displayName}</h3>
                  <span style={memorySectionStyles.muted}>{t('recordCount', { count: workspaceDrafts.length })}</span>
                </header>
                <section>
                  <h4>{t('workspaceIndex')}</h4>
                  <pre style={memorySectionStyles.workspaceIndex}>{workspace.index}</pre>
                </section>
                <section>
                  <header style={memorySectionStyles.recordSectionHeading}>
                    <h4 style={memorySectionStyles.recordSectionTitle}>{t('workspaceRecords')}</h4>
                    <MemoryButton type="button" style={memorySectionStyles.button} disabled={workspaceBusy} onClick={addWorkspaceRecord}>
                      {t('addRecord')}
                    </MemoryButton>
                  </header>
                  {draftIssue === undefined ? null : (
                    <p role="alert" style={memorySectionStyles.validation}>
                      {t(draftIssue === 'name'
                        ? 'workspaceInvalidName'
                        : draftIssue === 'duplicate-name'
                          ? 'workspaceDuplicateName'
                          : draftIssue === 'description'
                            ? 'workspaceInvalidDescription'
                            : 'workspaceInvalidContent')}
                    </p>
                  )}
                  {workspaceDrafts.length === 0 ? <p style={memorySectionStyles.muted}>{t('workspaceNoRecords')}</p> : null}
                  <div style={memorySectionStyles.recordList}>
                    {workspaceDrafts.map(record => (
                      <article key={record.draftId} style={memorySectionStyles.recordCard}>
                        <header style={memorySectionStyles.recordHeading}>
                          <strong>{record.name || t('newRecord')}</strong>
                          <MemoryButton
                            type="button"
                            variant="danger"
                            style={memorySectionStyles.dangerButton}
                            disabled={workspaceBusy}
                            onClick={() => { setWorkspaceDrafts(current => current.filter(candidate => candidate.draftId !== record.draftId)) }}
                          >
                            {t('deleteRecord')}
                          </MemoryButton>
                        </header>
                        <div style={memorySectionStyles.recordFields}>
                          <label style={memorySectionStyles.field}>
                            <span>{t('recordName')}</span>
                            <input
                              style={memorySectionStyles.input}
                              value={record.name}
                              disabled={workspaceBusy}
                              onChange={event => { updateWorkspaceDraft(record.draftId, { name: event.target.value }) }}
                            />
                          </label>
                          <label style={memorySectionStyles.field}>
                            <span>{t('recordType')}</span>
                            <select
                              style={memorySectionStyles.input}
                              value={record.type}
                              disabled={workspaceBusy}
                              onChange={event => { updateWorkspaceDraft(record.draftId, { type: event.target.value as WorkspaceRecordView['type'] }) }}
                            >
                              <option value="feedback">feedback</option>
                              <option value="project">project</option>
                              <option value="reference">reference</option>
                            </select>
                          </label>
                        </div>
                        <label style={memorySectionStyles.field}>
                          <span>{t('recordDescription')}</span>
                          <input
                            style={memorySectionStyles.input}
                            value={record.description}
                            disabled={workspaceBusy}
                            onChange={event => { updateWorkspaceDraft(record.draftId, { description: event.target.value }) }}
                          />
                        </label>
                        <label style={memorySectionStyles.field}>
                          <span>{t('recordContent')}</span>
                          <textarea
                            style={memorySectionStyles.recordEditor}
                            value={record.content}
                            disabled={workspaceBusy}
                            spellCheck={false}
                            onChange={event => { updateWorkspaceDraft(record.draftId, { content: event.target.value }) }}
                          />
                        </label>
                      </article>
                    ))}
                  </div>
                  <div style={{ ...memorySectionStyles.actions, ...memorySectionStyles.workspaceActions }}>
                    <MemoryButton type="button" style={memorySectionStyles.button} disabled={workspaceBusy || !workspaceDirty} onClick={discardWorkspaceChanges}>
                      {t('discardChanges')}
                    </MemoryButton>
                    <MemoryButton
                      type="button"
                      variant="primary"
                      style={memorySectionStyles.primaryButton}
                      disabled={workspaceBusy || !workspaceDirty || draftIssue !== undefined}
                      onClick={() => { void saveWorkspace() }}
                    >
                      {t('saveWorkspace')}
                    </MemoryButton>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      ) : (
        <div style={memorySectionStyles.sessionPanel}>
          <header style={memorySectionStyles.workspaceHeading}>
            <div>
              <h3 style={memorySectionStyles.workspaceTitle}>{t('sessionCandidates')}</h3>
              <p style={memorySectionStyles.subtitle}>{t('sessionCandidateHelp')}</p>
            </div>
            <span style={memorySectionStyles.muted}>{t('sessionCount', { count: sessions?.sessions.length ?? 0 })}</span>
          </header>
          {sessionBusy && sessions === undefined ? <p>{t('loading')}</p> : null}
          {sessions?.available === false ? <p style={memorySectionStyles.validation}>{t('sessionUnavailable')}</p> : null}
          {sessions?.available === true && sessions.sessions.length === 0
            ? <p style={memorySectionStyles.muted}>{t('sessionEmpty')}</p>
            : null}
          <div style={memorySectionStyles.sessionList}>
            {sessions?.sessions.map(session => (
              <article key={session.sessionId} style={memorySectionStyles.sessionCard}>
                <header style={memorySectionStyles.recordHeading}>
                  <strong style={memorySectionStyles.sessionId}>{session.sessionId}</strong>
                  <span style={session.eligible ? memorySectionStyles.eligibleBadge : memorySectionStyles.ineligibleBadge}>
                    {session.eligible ? t('sessionEligible') : t(sessionReasonKey(session.reason))}
                  </span>
                </header>
                <div style={memorySectionStyles.sessionMeta}>
                  <span>{t('sessionWorkspace', { value: session.workspaceName ?? '—' })}</span>
                  <span>{t('sessionCreatedAt', { value: new Date(session.createdAt).toISOString() })}</span>
                  <span>{t('sessionNoReceipt')}</span>
                </div>
              </article>
            ))}
          </div>
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
  button: { padding: '8px 12px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  primaryButton: { padding: '9px 14px', borderRadius: 8, border: 0, background: '#5b5bd6', color: '#fff', fontWeight: 600, cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  status: { display: 'flex', flexWrap: 'wrap', gap: '8px 20px', padding: 14, borderRadius: 10, background: 'rgba(127,127,127,0.12)', boxSizing: 'border-box', width: '100%', maxWidth: '100%', minWidth: 0 },
  path: { flexBasis: '100%', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 8, borderBottom: '1px solid rgba(127,127,127,0.3)', maxWidth: '100%', minWidth: 0 },
  tab: { padding: '9px 12px', border: 0, borderBottom: '2px solid transparent', borderRadius: '8px 8px 0 0', background: 'transparent', color: 'inherit', opacity: 0.7, cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  activeTab: { borderBottom: '2px solid #5b5bd6', opacity: 1, fontWeight: 600 },
  panel: { display: 'grid', gap: 10, width: '100%', maxWidth: '100%', minWidth: 0 },
  editor: { display: 'block', minHeight: 320, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', resize: 'vertical', borderRadius: 10, padding: 14, border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.06)', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5 },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12, alignItems: 'center', minWidth: 0 },
  workspaceActions: { marginTop: 16 },
  error: { margin: 0, padding: 12, borderRadius: 8, background: 'rgba(200,40,40,0.15)', color: '#d44', overflowWrap: 'anywhere' },
  sessionPanel: { display: 'grid', gap: 14, width: '100%', maxWidth: '100%', minWidth: 0 },
  sessionList: { display: 'grid', gap: 10, minWidth: 0 },
  sessionCard: { display: 'grid', gap: 10, padding: 14, minWidth: 0, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 10 },
  sessionId: { minWidth: 0, overflowWrap: 'anywhere' },
  sessionMeta: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px', minWidth: 0, opacity: 0.72, fontSize: 13 },
  eligibleBadge: { padding: '3px 8px', borderRadius: 999, background: 'rgba(45,160,90,0.18)', color: '#2a9d58', fontSize: 12, fontWeight: 600 },
  ineligibleBadge: { padding: '3px 8px', borderRadius: 999, background: 'rgba(127,127,127,0.16)', color: 'inherit', opacity: 0.76, fontSize: 12 },
  workspaceLayout: { display: 'flex', flexWrap: 'wrap', gap: 16, width: '100%', maxWidth: '100%', minWidth: 0, alignItems: 'flex-start' },
  workspaceList: { display: 'grid', gap: 8, flex: '1 1 180px', maxWidth: '100%', minWidth: 0 },
  workspaceButton: { display: 'grid', gap: 4, width: '100%', minWidth: 0, padding: 12, textAlign: 'left', border: '1px solid rgba(127,127,127,0.3)', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  activeWorkspaceButton: { background: 'rgba(91,91,214,0.16)', border: '1px solid #5b5bd6' },
  workspaceDetail: { display: 'grid', gap: 16, flex: '3 1 360px', maxWidth: '100%', minWidth: 0 },
  workspaceHeading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, minWidth: 0 },
  workspaceTitle: { margin: 0, overflowWrap: 'anywhere' },
  workspaceIndex: { margin: 0, padding: 12, maxWidth: '100%', minWidth: 0, overflowX: 'auto', boxSizing: 'border-box', borderRadius: 8, background: 'rgba(127,127,127,0.08)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  recordList: { display: 'grid', gap: 12, minWidth: 0 },
  recordSectionHeading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 },
  recordSectionTitle: { margin: 0 },
  recordCard: { display: 'grid', gap: 12, padding: 14, minWidth: 0, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 10 },
  recordHeading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, minWidth: 0 },
  recordFields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12, minWidth: 0 },
  field: { display: 'grid', gap: 6, minWidth: 0 },
  input: { width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', padding: '8px 10px', border: '1px solid rgba(127,127,127,0.4)', borderRadius: 8, background: 'rgba(127,127,127,0.06)', color: 'inherit' },
  recordEditor: { display: 'block', minHeight: 150, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', resize: 'vertical', padding: 10, border: '1px solid rgba(127,127,127,0.4)', borderRadius: 8, background: 'rgba(127,127,127,0.06)', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5 },
  dangerButton: { padding: '6px 10px', borderRadius: 8, border: '1px solid #c44', background: 'transparent', color: '#c44', cursor: 'pointer', transition: 'background-color 140ms ease, transform 140ms ease, box-shadow 140ms ease, filter 140ms ease' },
  validation: { margin: '0 0 12px', padding: 10, borderRadius: 8, background: 'rgba(200,140,40,0.15)', color: 'inherit' },
  muted: { opacity: 0.68 },
}

export const memoryButtonHoverStyles: Record<MemoryButtonVariant, React.CSSProperties> = {
  default: { background: 'rgba(127,127,127,0.13)', transform: 'translateY(-1px)', boxShadow: '0 3px 10px rgba(0,0,0,0.12)' },
  primary: { filter: 'brightness(1.1)', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(91,91,214,0.3)' },
  danger: { background: 'rgba(204,68,68,0.12)', transform: 'translateY(-1px)', boxShadow: '0 3px 10px rgba(204,68,68,0.14)' },
  tab: { background: 'rgba(127,127,127,0.1)' },
  workspace: { background: 'rgba(91,91,214,0.1)', transform: 'translateY(-1px)', boxShadow: '0 3px 10px rgba(0,0,0,0.1)' },
}

export const memoryButtonPressedStyle: React.CSSProperties = {
  transform: 'translateY(0) scale(0.98)',
  boxShadow: 'none',
}

export const memoryButtonDisabledStyle: React.CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.48,
  filter: 'none',
  transform: 'none',
  boxShadow: 'none',
}

function sessionReasonKey(reason: SessionIneligibleReason): MemoryLocaleKey {
  switch (reason) {
    case 'live': return 'sessionReasonLive'
    case 'missing-cwd': return 'sessionReasonMissingCwd'
    case 'workspace-unavailable': return 'sessionReasonWorkspaceUnavailable'
    case 'unstable': return 'sessionReasonUnstable'
  }
}
