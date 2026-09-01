/** Runtime validation and deterministic planning for one model-proposed consolidation. */

import {
  MemoryValidationError,
  previewGlobalMemory,
  previewWorkspaceChanges,
  type GlobalMemoryPreview,
  type GlobalMemoryView,
  type WorkspaceMemory,
  type WorkspaceMemoryChange,
  type WorkspaceMemoryPreview,
  type WorkspaceMemoryType,
  type WorkspaceMemoryView,
} from './memory-store.ts'
import type { ConsolidationEvidenceTurn } from './consolidation-evidence.ts'

/** Inclusive source Session evidence interval. */
export interface ConsolidationEvidenceRange {
  readonly fromSeq: number
  readonly toSeq: number
}

/** One validated model-proposed Workspace change with source evidence. */
export type ConsolidationProposalChange =
  | {
      readonly action: 'replace-global'
      readonly content: string
      readonly evidence: readonly ConsolidationEvidenceRange[]
    }
  | {
      readonly action: 'put'
      readonly record: WorkspaceMemory
      readonly evidence: readonly ConsolidationEvidenceRange[]
    }
  | {
      readonly action: 'delete'
      readonly name: string
      readonly evidence: readonly ConsolidationEvidenceRange[]
    }

/** Closed semantic result accepted from the consolidation worker. */
export type ConsolidationProposal =
  | { readonly outcome: 'no-change'; readonly changes: readonly [] }
  | { readonly outcome: 'changes'; readonly changes: readonly ConsolidationProposalChange[] }

/** Canonical proposal plus the exact Workspace generation it would produce. */
export interface ConsolidationProposalPlan {
  readonly proposal: ConsolidationProposal
  readonly globalBefore: GlobalMemoryView
  readonly globalPreview: GlobalMemoryPreview
  readonly preview: WorkspaceMemoryPreview
}

/** Raised when an untrusted worker proposal violates the closed contract. */
export class ConsolidationProposalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConsolidationProposalError'
  }
}

/** Parse, validate, canonicalize, and preview one untrusted worker proposal. */
export function parseConsolidationProposal(
  value: unknown,
  input: {
    readonly sourceEvidence: readonly ConsolidationEvidenceTurn[]
    readonly global: GlobalMemoryView
    readonly workspace: WorkspaceMemoryView
  },
): ConsolidationProposalPlan {
  const candidate = requireRecord(value, 'proposal')
  requireExactKeys(candidate, ['outcome', 'changes'], 'proposal')
  if (!Array.isArray(candidate.changes)) {
    throw new ConsolidationProposalError('proposal.changes must be an array')
  }
  if (candidate.outcome === 'no-change') {
    if (candidate.changes.length !== 0) {
      throw new ConsolidationProposalError('proposal.changes must be empty when outcome is no-change')
    }
    return {
      proposal: { outcome: 'no-change', changes: [] },
      globalBefore: { ...input.global },
      globalPreview: unchangedGlobalPreview(input.global),
      preview: unchangedPreview(input.workspace),
    }
  }
  if (candidate.outcome !== 'changes') {
    throw new ConsolidationProposalError('proposal.outcome must be no-change or changes')
  }
  if (candidate.changes.length === 0) {
    throw new ConsolidationProposalError('proposal.changes must be non-empty when outcome is changes')
  }

  const allowedEvidence = evidenceRanges(input.sourceEvidence)
  const changes = candidate.changes.map((change, index) => parseChange(change, index, allowedEvidence))
  const names = new Set<string>()
  for (const change of changes) {
    const name = change.action === 'replace-global' ? '@global' : change.action === 'put' ? change.record.name : change.name
    if (names.has(name)) {
      throw new ConsolidationProposalError(`proposal.changes contains more than one change for ${name}`)
    }
    names.add(name)
  }
  changes.sort(compareChanges)

  const globalChange = changes.find(change => change.action === 'replace-global')
  const globalPreview = globalChange?.action === 'replace-global'
    ? previewGlobalMemory(input.global, globalChange.content)
    : unchangedGlobalPreview(input.global)
  let preview: WorkspaceMemoryPreview
  try {
    const workspaceChanges = changes.filter(isWorkspaceChange).map(toMemoryChange)
    preview = workspaceChanges.length === 0
      ? unchangedPreview(input.workspace)
      : previewWorkspaceChanges(input.workspace, workspaceChanges)
  } catch (cause: unknown) {
    if (cause instanceof MemoryValidationError) {
      throw new ConsolidationProposalError(`proposal changes are invalid: ${cause.message}`, { cause })
    }
    throw cause
  }
  if (!globalPreview.changed && !preview.changed) {
    return { proposal: { outcome: 'no-change', changes: [] }, globalBefore: { ...input.global }, globalPreview, preview }
  }
  return { proposal: { outcome: 'changes', changes }, globalBefore: { ...input.global }, globalPreview, preview }
}

function parseChange(
  value: unknown,
  index: number,
  allowedEvidence: ReadonlySet<string>,
): ConsolidationProposalChange {
  const label = `proposal.changes[${index}]`
  const change = requireRecord(value, label)
  if (change.action === 'replace-global') {
    requireExactKeys(change, ['action', 'content', 'evidence'], label)
    if (typeof change.content !== 'string') {
      throw new ConsolidationProposalError(`${label}.content must be a string`)
    }
    return {
      action: 'replace-global',
      content: change.content,
      evidence: parseEvidence(change.evidence, `${label}.evidence`, allowedEvidence),
    }
  }
  if (change.action === 'put') {
    requireExactKeys(change, ['action', 'record', 'evidence'], label)
    return {
      action: 'put',
      record: parseRecord(change.record, `${label}.record`),
      evidence: parseEvidence(change.evidence, `${label}.evidence`, allowedEvidence),
    }
  }
  if (change.action === 'delete') {
    requireExactKeys(change, ['action', 'name', 'evidence'], label)
    if (typeof change.name !== 'string') {
      throw new ConsolidationProposalError(`${label}.name must be a string`)
    }
    return {
      action: 'delete',
      name: change.name,
      evidence: parseEvidence(change.evidence, `${label}.evidence`, allowedEvidence),
    }
  }
  throw new ConsolidationProposalError(`${label}.action must be replace-global, put, or delete`)
}

function parseRecord(value: unknown, label: string): WorkspaceMemory {
  const record = requireRecord(value, label)
  requireExactKeys(record, ['name', 'description', 'type', 'content'], label)
  if (typeof record.name !== 'string') throw new ConsolidationProposalError(`${label}.name must be a string`)
  if (typeof record.description !== 'string') throw new ConsolidationProposalError(`${label}.description must be a string`)
  if (!isWorkspaceMemoryType(record.type)) {
    throw new ConsolidationProposalError(`${label}.type must be feedback, project, or reference`)
  }
  if (typeof record.content !== 'string') throw new ConsolidationProposalError(`${label}.content must be a string`)
  return {
    name: record.name,
    description: record.description,
    type: record.type,
    content: record.content,
  }
}

function parseEvidence(
  value: unknown,
  label: string,
  allowedEvidence: ReadonlySet<string>,
): ConsolidationEvidenceRange[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConsolidationProposalError(`${label} must be a non-empty array`)
  }
  const ranges = value.map((candidate, index) => {
    const rangeLabel = `${label}[${index}]`
    const range = requireRecord(candidate, rangeLabel)
    requireExactKeys(range, ['fromSeq', 'toSeq'], rangeLabel)
    if (!Number.isSafeInteger(range.fromSeq) || !Number.isSafeInteger(range.toSeq)) {
      throw new ConsolidationProposalError(`${rangeLabel} boundaries must be safe integers`)
    }
    const fromSeq = range.fromSeq as number
    const toSeq = range.toSeq as number
    if (fromSeq > toSeq) throw new ConsolidationProposalError(`${rangeLabel}.fromSeq must not exceed toSeq`)
    if (!allowedEvidence.has(rangeKey(fromSeq, toSeq))) {
      throw new ConsolidationProposalError(`${rangeLabel} must exactly match a supplied evidence turn`)
    }
    return { fromSeq, toSeq }
  })
  return ranges.sort((left, right) => left.fromSeq - right.fromSeq || left.toSeq - right.toSeq)
}

function evidenceRanges(evidence: readonly ConsolidationEvidenceTurn[]): Set<string> {
  const ranges = new Set<string>()
  let previousTo = -1
  for (const [index, turn] of evidence.entries()) {
    if (!Number.isSafeInteger(turn.fromSeq) || !Number.isSafeInteger(turn.toSeq)
      || turn.fromSeq < 0 || turn.fromSeq > turn.toSeq || turn.fromSeq <= previousTo) {
      throw new TypeError(`sourceEvidence[${index}] must have an ordered non-overlapping event range`)
    }
    ranges.add(rangeKey(turn.fromSeq, turn.toSeq))
    previousTo = turn.toSeq
  }
  return ranges
}

function rangeKey(fromSeq: number, toSeq: number): string {
  return `${fromSeq}:${toSeq}`
}

function compareChanges(left: ConsolidationProposalChange, right: ConsolidationProposalChange): number {
  if (left.action === 'replace-global' || right.action === 'replace-global') {
    return left.action === right.action ? 0 : left.action === 'replace-global' ? -1 : 1
  }
  if (left.action !== right.action) return left.action === 'delete' ? -1 : 1
  const leftName = left.action === 'put' ? left.record.name : left.name
  const rightName = right.action === 'put' ? right.record.name : right.name
  return leftName.localeCompare(rightName, 'en')
}

function isWorkspaceChange(change: ConsolidationProposalChange): change is Exclude<ConsolidationProposalChange, { action: 'replace-global' }> {
  return change.action !== 'replace-global'
}

function toMemoryChange(change: Exclude<ConsolidationProposalChange, { action: 'replace-global' }>): WorkspaceMemoryChange {
  return change.action === 'put'
    ? { action: 'put', record: change.record }
    : { action: 'delete', name: change.name }
}

function unchangedGlobalPreview(global: GlobalMemoryView): GlobalMemoryPreview {
  return { ...global, changed: false }
}

function unchangedPreview(workspace: WorkspaceMemoryView): WorkspaceMemoryPreview {
  return {
    changed: false,
    records: workspace.records.map(record => ({ ...record })),
    index: workspace.index,
    revision: workspace.revision,
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConsolidationProposalError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const canonical = [...expected].sort()
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new ConsolidationProposalError(`${label} must contain exactly: ${canonical.join(', ')}`)
  }
}

function isWorkspaceMemoryType(value: unknown): value is WorkspaceMemoryType {
  return value === 'feedback' || value === 'project' || value === 'reference'
}
