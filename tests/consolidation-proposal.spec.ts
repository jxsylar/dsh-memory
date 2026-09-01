import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConsolidationProposalError,
  parseConsolidationProposal,
} from '../src/consolidation-proposal.ts'
import { MarkdownMemoryStore, type WorkspaceMemoryView } from '../src/memory-store.ts'

const roots: string[] = []
const evidence = [
  { fromSeq: 0, toSeq: 0, user: ['first'], summaries: [], assistantFinal: null, tools: [] },
  { fromSeq: 1, toSeq: 1, user: ['second'], summaries: [], assistantFinal: null, tools: [] },
  { fromSeq: 2, toSeq: 3, user: ['third'], summaries: [], assistantFinal: null, tools: [] },
]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function workspace(): Promise<{
  store: MarkdownMemoryStore
  scope: ReturnType<MarkdownMemoryStore['scopeForCwd']>
  view: WorkspaceMemoryView
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-proposal-'))
  roots.push(root)
  const store = new MarkdownMemoryStore(new Context(), join(root, 'memory'))
  store.initialize()
  const scope = store.scopeForCwd('/work/proposal')
  const empty = await store.readWorkspace(scope)
  await store.commitWorkspace({
    scope,
    expectedRevision: empty.revision,
    changes: [
      { action: 'put', record: {
        name: 'obsolete-rule',
        description: 'An obsolete project rule.',
        type: 'project',
        content: 'Old rule.\n',
      } },
      { action: 'put', record: {
        name: 'stable-rule',
        description: 'A stable project rule.',
        type: 'feedback',
        content: 'Keep this.\n',
      } },
    ],
  })
  return { store, scope, view: await store.readWorkspace(scope) }
}

describe('consolidation proposal planning', () => {
  it('previews a Global replacement alongside Workspace changes', async () => {
    const target = await workspace()
    const global = await target.store.readGlobal()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'replace-global',
        content: `${global.content}\n- Prefer concise answers.`,
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global, workspace: target.view })

    expect(planned.globalPreview).toMatchObject({ changed: true, content: expect.stringContaining('Prefer concise answers') })
    expect(planned.preview).toMatchObject({ changed: false, revision: target.view.revision })
  })

  it('closes the schema, canonicalizes changes, and previews the committed revision', async () => {
    const target = await workspace()
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [
        {
          action: 'put',
          record: {
            name: 'new-guidance',
            description: 'New durable guidance.',
            type: 'feedback',
            content: 'Prefer the narrow verification path.',
          },
          evidence: [{ fromSeq: 2, toSeq: 3 }, { fromSeq: 0, toSeq: 0 }],
        },
        {
          action: 'delete',
          name: 'obsolete-rule',
          evidence: [{ fromSeq: 1, toSeq: 1 }],
        },
      ],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })

    expect(planned.proposal).toEqual({
      outcome: 'changes',
      changes: [
        {
          action: 'delete',
          name: 'obsolete-rule',
          evidence: [{ fromSeq: 1, toSeq: 1 }],
        },
        {
          action: 'put',
          record: {
            name: 'new-guidance',
            description: 'New durable guidance.',
            type: 'feedback',
            content: 'Prefer the narrow verification path.',
          },
          evidence: [{ fromSeq: 0, toSeq: 0 }, { fromSeq: 2, toSeq: 3 }],
        },
      ],
    })
    expect(planned.preview).toMatchObject({
      changed: true,
      revision: expect.stringMatching(/^sha256:/u),
      records: [{ name: 'new-guidance' }, { name: 'stable-rule' }],
    })

    if (planned.proposal.outcome !== 'changes') throw new Error('expected changes')
    const committed = await target.store.commitWorkspace({
      scope: target.scope,
      expectedRevision: target.view.revision,
      changes: planned.proposal.changes.filter(change => change.action !== 'replace-global').map(change => change.action === 'put'
        ? { action: 'put', record: change.record }
        : { action: 'delete', name: change.name }),
    })
    expect(committed.revision).toBe(planned.preview.revision)
    expect((await target.store.readWorkspace(target.scope)).records).toEqual(planned.preview.records)
  })

  it('normalizes a semantically identical put to no-change without changing revision', async () => {
    const target = await workspace()
    const stable = target.view.records.find(record => record.name === 'stable-rule')!
    const planned = parseConsolidationProposal({
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: { ...stable, content: stable.content.trimEnd() },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, { sourceEvidence: evidence, global: await target.store.readGlobal(), workspace: target.view })

    expect(planned.proposal).toEqual({ outcome: 'no-change', changes: [] })
    expect(planned.preview).toMatchObject({ changed: false, revision: target.view.revision })
  })

  it('accepts an explicit no-change for an empty source without invoking change validation', async () => {
    const target = await workspace()
    expect(parseConsolidationProposal(
      { outcome: 'no-change', changes: [] },
      { sourceEvidence: [], global: await target.store.readGlobal(), workspace: target.view },
    )).toMatchObject({
      proposal: { outcome: 'no-change', changes: [] },
      preview: { changed: false, revision: target.view.revision },
    })
  })

  it.each([
    ['unknown proposal field', { outcome: 'no-change', changes: [], revision: 'sha256:unsafe' }, /exactly/],
    ['changes attached to no-change', { outcome: 'no-change', changes: [{}] }, /must be empty/],
    ['empty changes outcome', { outcome: 'changes', changes: [] }, /non-empty/],
    ['unknown change field', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 0, toSeq: 0 }], path: '/tmp' }],
    }, /exactly/],
    ['missing evidence', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [] }],
    }, /non-empty/],
    ['reversed evidence', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 2, toSeq: 1 }] }],
    }, /must not exceed/],
    ['unsupplied evidence range', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 0, toSeq: 4 }] }],
    }, /supplied evidence turn/],
    ['invalid record', {
      outcome: 'changes',
      changes: [{
        action: 'put',
        record: { name: '../escape', description: 'Unsafe.', type: 'project', content: 'Unsafe.' },
        evidence: [{ fromSeq: 0, toSeq: 0 }],
      }],
    }, /kebab-case/],
    ['missing delete target', {
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'missing-rule', evidence: [{ fromSeq: 0, toSeq: 0 }] }],
    }, /does not exist/],
    ['same-name put and delete', {
      outcome: 'changes',
      changes: [
        { action: 'delete', name: 'stable-rule', evidence: [{ fromSeq: 0, toSeq: 0 }] },
        {
          action: 'put',
          record: { name: 'stable-rule', description: 'Replacement.', type: 'project', content: 'Replacement.' },
          evidence: [{ fromSeq: 1, toSeq: 1 }],
        },
      ],
    }, /more than one change/],
  ])('rejects %s', async (_name, value, pattern) => {
    const target = await workspace()
    const global = await target.store.readGlobal()
    expect(() => parseConsolidationProposal(value, {
      sourceEvidence: evidence,
      global,
      workspace: target.view,
    }))
      .toThrow(pattern as RegExp)
  })

  it('rejects malformed evidence ranges separately from model proposal validation', async () => {
    const target = await workspace()
    const global = await target.store.readGlobal()
    expect(() => parseConsolidationProposal({
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 0, toSeq: 0 }] }],
    }, {
      sourceEvidence: [evidence[1]!, evidence[0]!],
      global,
      workspace: target.view,
    })).toThrow(TypeError)
    expect(() => parseConsolidationProposal({
      outcome: 'changes',
      changes: [{ action: 'delete', name: 'obsolete-rule', evidence: [{ fromSeq: 0, toSeq: 0 }] }],
    }, {
      sourceEvidence: [evidence[1]!, evidence[0]!],
      global,
      workspace: target.view,
    })).not.toThrow(ConsolidationProposalError)
  })
})
