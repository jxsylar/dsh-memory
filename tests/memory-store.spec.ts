import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MarkdownMemoryStore,
  MemoryConflictError,
  MemoryValidationError,
} from '../src/memory-store.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): MarkdownMemoryStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  roots.push(root)
  return new MarkdownMemoryStore(new Context(), root)
}

describe('MarkdownMemoryStore', () => {
  it('initializes and revision-checks GLOBAL.md', async () => {
    const memory = store()
    memory.initialize()
    const initial = await memory.readGlobal()
    expect(initial.content).toContain('# Global Memory')

    const committed = await memory.commitGlobal({
      expectedRevision: initial.revision,
      content: '# Global Memory\n\n- Prefer Chinese.\n\n',
    })
    expect(committed.revision).not.toBe(initial.revision)
    expect((await memory.readGlobal()).content).toBe('# Global Memory\n\n- Prefer Chinese.\n')

    await expect(memory.commitGlobal({
      expectedRevision: initial.revision,
      content: '# stale\n',
    })).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('publishes validated Workspace records with a generated index', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/example')
    const empty = await memory.readWorkspace(scope)

    const committed = await memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{
        action: 'put',
        record: {
          name: 'review-before-publish',
          description: 'Run focused checks before publishing.',
          type: 'feedback',
          content: 'Run the smallest relevant checks before publishing.\n\n**Why:** Avoid preventable regressions.\n\n**How to apply:** Select checks from the changed surface.\n',
        },
      }],
    })
    const view = await memory.readWorkspace(scope)
    expect(view.revision).toBe(committed.revision)
    expect(view.records).toHaveLength(1)
    expect(view.index).toContain('[review-before-publish](review-before-publish.md)')
    expect(readFileSync(join(scope.directory, 'MEMORY.md'), 'utf8')).toBe(view.index)
    expect(readFileSync(join(scope.directory, 'review-before-publish.md'), 'utf8')).toContain('type: feedback')
  })

  it('deletes a record as one revision-checked Workspace generation', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/delete')
    const empty = await memory.readWorkspace(scope)
    const created = await memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: 'temporary-reference',
        description: 'A reference that will be removed.',
        type: 'reference',
        content: 'https://example.com\n',
      } }],
    })
    const deleted = await memory.commitWorkspace({
      scope,
      expectedRevision: created.revision,
      changes: [{ action: 'delete', name: 'temporary-reference' }],
    })
    expect(deleted.operation).toBe('delete')
    expect((await memory.readWorkspace(scope)).records).toEqual([])
  })

  it('rejects unsafe record names before writing', async () => {
    const memory = store()
    memory.initialize()
    const scope = memory.scopeForCwd('/work/reject')
    const empty = await memory.readWorkspace(scope)
    await expect(memory.commitWorkspace({
      scope,
      expectedRevision: empty.revision,
      changes: [{ action: 'put', record: {
        name: '../escape',
        description: 'Must not leave the Workspace directory.',
        type: 'project',
        content: 'unsafe\n',
      } }],
    })).rejects.toBeInstanceOf(MemoryValidationError)
  })

  it('renders only Global memory when a Session has no cwd', () => {
    const memory = store()
    memory.initialize()
    expect(memory.renderContext()).toContain('### Global Memory')
    expect(memory.renderContext()).not.toContain('### Current Workspace Memory Index')
  })
})
