/** Persistent model selection and active DSH model catalog projection. */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { ConsolidationWorkerConfig } from './consolidation-worker.ts'
import type {
  ConsolidationModelCatalogResponse,
  ConsolidationModelSelection,
  MemoryRevision,
} from './protocol.ts'

const SETTINGS_FORMAT = 1

export interface MemoryLlmCatalog {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{
    provider: string
    id: string
    name: string
    description?: string
    inputModalities?: readonly string[]
  }>>
}

export interface ConsolidationSettingsView {
  readonly selection: ConsolidationModelSelection
  readonly revision: MemoryRevision
}

/** Plugin-owned settings file; memory Markdown remains the only authoritative memory data. */
export class ConsolidationSettingsStore {
  readonly path: string

  constructor(
    root: string,
    private readonly defaults: Pick<ConsolidationWorkerConfig, 'provider' | 'model'>,
  ) {
    this.path = join(root, 'settings.yml')
  }

  read(): ConsolidationSettingsView {
    const selection = existsSync(this.path)
      ? parseSettings(readFileSync(this.path, 'utf8'))
      : validateSelection(this.defaults)
    return { selection, revision: settingsRevision(selection) }
  }

  commit(input: {
    expectedRevision: MemoryRevision
    selection: ConsolidationModelSelection
  }): { status: 'committed'; revision: MemoryRevision } | { status: 'conflict'; currentRevision: MemoryRevision } {
    const current = this.read()
    if (current.revision !== input.expectedRevision) {
      return { status: 'conflict', currentRevision: current.revision }
    }
    const selection = validateSelection(input.selection)
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, serializeSettings(selection), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
    return { status: 'committed', revision: settingsRevision(selection) }
  }
}

/** Read active adapters and their text-capable model catalogs from DSH. */
export async function readConsolidationModelCatalog(
  llm: MemoryLlmCatalog,
  settings: ConsolidationSettingsStore,
): Promise<ConsolidationModelCatalogResponse> {
  const current = settings.read()
  const results = await Promise.all(llm.listProviders().map(async (provider) => {
    try {
      const models = (await llm.listModels(provider.id))
        .filter(model => model.inputModalities === undefined || model.inputModalities.includes('text'))
        .map(model => ({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
        }))
      return { provider: { id: provider.id, name: provider.name, models }, failure: undefined }
    } catch (error: unknown) {
      return {
        provider: undefined,
        failure: { provider: provider.id, message: safeDiagnosticMessage(error) },
      }
    }
  }))
  return {
    available: true,
    selection: current.selection,
    revision: current.revision,
    providers: results.flatMap(result => result.provider === undefined ? [] : [result.provider]),
    failures: results.flatMap(result => result.failure === undefined ? [] : [result.failure]),
  }
}

export function selectionIsAvailable(
  catalog: ConsolidationModelCatalogResponse,
  selection: ConsolidationModelSelection,
): boolean {
  return catalog.providers.some(provider => provider.id === selection.provider
    && provider.models.some(model => model.id === selection.model))
}

function parseSettings(source: string): ConsolidationModelSelection {
  let value: unknown
  try {
    value = parse(source)
  } catch (cause: unknown) {
    throw new TypeError('Memory consolidation settings are not valid YAML', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Memory consolidation settings must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'format,model,provider' || record.format !== SETTINGS_FORMAT) {
    throw new TypeError('Memory consolidation settings have missing or unknown fields')
  }
  return validateSelection({ provider: record.provider, model: record.model })
}

function validateSelection(value: { provider: unknown; model: unknown }): ConsolidationModelSelection {
  if (typeof value.provider !== 'string' || value.provider.trim() === '' || /[\r\n]/u.test(value.provider)) {
    throw new TypeError('consolidation provider must be a non-empty single line')
  }
  if (typeof value.model !== 'string' || value.model.trim() === '' || /[\r\n]/u.test(value.model)) {
    throw new TypeError('consolidation model must be a non-empty single line')
  }
  return { provider: value.provider, model: value.model }
}

function serializeSettings(selection: ConsolidationModelSelection): string {
  return stringify({ format: SETTINGS_FORMAT, provider: selection.provider, model: selection.model }, { lineWidth: 0 })
}

function settingsRevision(selection: ConsolidationModelSelection): MemoryRevision {
  return `sha256:${createHash('sha256').update(serializeSettings(selection), 'utf8').digest('hex')}` as MemoryRevision
}

function safeDiagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/(?:sk|key|token)-[A-Za-z0-9._-]{8,}/gu, '[REDACTED]')
    .replace(/[\r\n]+/gu, ' ')
    .trim() || 'model catalog failed'
}
